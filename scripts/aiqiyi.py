"""
爱奇艺弹幕下载
用法: python3 scripts/aiqiyi.py <tvid>
      python3 scripts/aiqiyi.py <tvid> <输出文件.json>
"""
import sys
import json
import zlib
import re
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
}

def fetch_page(tvid, page):
    """下载一页弹幕（旧版 XML + zlib 格式）"""
    a = tvid[-4:-2]
    b = tvid[-2:]
    url = f"https://cmts.iqiyi.com/bullet/{a}/{b}/{tvid}_300_{page}.z"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        return None
    try:
        xml = zlib.decompress(resp.content).decode('utf-8')
    except zlib.error:
        # 尝试 brotli（新版）
        import brotli
        xml = brotli.decompress(resp.content).decode('utf-8')
    return xml


def parse_xml(xml):
    """解析爱奇艺弹幕 XML"""
    danmakus = []
    # XML 格式: <bulletInfo>...<content>xxx</content><likeCount>...</likeCount>...</bulletInfo>
    entries = re.findall(r'<bulletInfo>(.*?)</bulletInfo>', xml, re.DOTALL)
    for entry in entries:
        content_id = re.search(r'<contentId>(.*?)</contentId>', entry)
        content = re.search(r'<content>(.*?)</content>', entry)
        like_count = re.search(r'<likeCount>(.*?)</likeCount>', entry)
        uid = re.search(r'<uid>(.*?)</uid>', entry)
        # 时间坐标（1/10秒）
        show_time = re.search(r'<showTime>(\d+)</showTime>', entry)
        # 颜色（可选）
        color = re.search(r'<color>(.*?)</color>', entry)

        if content and content.group(1):
            danmakus.append({
                'text': content.group(1),
                'time': int(show_time.group(1)) if show_time else 0,  # showTime 单位是秒
                'color': '#' + color.group(1) if color else '#ffffff',
                'likes': int(like_count.group(1)) if like_count else 0,
                'uid': uid.group(1) if uid else '',
            })
    return danmakus


def fetch_all(tvid):
    """拉取全部弹幕页"""
    all_danmakus = []
    page = 1
    while True:
        print(f'请求第 {page} 页...', end=' ')
        xml = fetch_page(tvid, page)
        if xml is None:
            print('404 或失败，停止')
            break
        danmakus = parse_xml(xml)
        all_danmakus.extend(danmakus)
        print(f'{len(danmakus)} 条 (累计 {len(all_danmakus)})')
        if len(danmakus) == 0:
            break
        page += 1
    return all_danmakus


def fetch_album(tvid):
    """从任一集的 tvid 查整季列表"""
    info_url = f'https://pcw-api.iqiyi.com/video/video/baseinfo/{tvid}'
    resp = requests.get(info_url, headers=HEADERS)
    if resp.status_code != 200:
        print('获取视频信息失败')
        return
    album_id = resp.json().get('data', {}).get('albumId')
    if not album_id:
        print('未找到 albumId')
        return

    album_url = f'https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid={album_id}&page=1&size=50'
    resp = requests.get(album_url, headers=HEADERS)
    data = resp.json()
    episodes = data.get('data', {}).get('epsodelist', [])
    print(f'albumId={album_id}  共 {len(episodes)} 集\n')
    for ep in episodes:
        tv = ep.get('tvId')
        name = ep.get('name', '')
        order = ep.get('order', '')
        dur = ep.get('duration', '')
        vip = 'VIP' if ep.get('payMark') else '免费'
        print(f'E{order:02d}  tvId={tv}  [{vip}] {dur}  {name}')


def rename_folder(tvid, folder):
    """根据专辑信息批量重命名文件夹内的视频文件"""
    import os
    import glob

    # 获取整季列表
    info_url = f'https://pcw-api.iqiyi.com/video/video/baseinfo/{tvid}'
    resp = requests.get(info_url, headers=HEADERS)
    album_id = resp.json().get('data', {}).get('albumId')
    if not album_id:
        print('未找到 albumId')
        return

    album_url = f'https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid={album_id}&page=1&size=50'
    resp = requests.get(album_url, headers=HEADERS)
    episodes = resp.json().get('data', {}).get('epsodelist', [])

    # 建立 order → tvId 映射
    ep_map = {}
    for ep in episodes:
        order = int(ep.get('order', 0))
        ep_map[order] = str(ep.get('tvId', ''))

    # 扫描文件夹
    video_exts = {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v'}
    files = [f for f in os.listdir(folder)
             if os.path.splitext(f)[1].lower() in video_exts]

    renamed = 0
    for fname in sorted(files):
        base, ext = os.path.splitext(fname)
        full = fname

        # 已包含 16 位 tvid，跳过
        if re.search(r'\d{16}', base):
            print(f'跳过 (已有ID): {fname}')
            continue

        # 提取集数: S01E07 / EP07 / 第7集
        ep_num = None
        for pat in [r'S\d+E(\d+)', r'(?:^|[_\s.-])EP?(\d{1,3})(?=$|[_\s.-])', r'第\s*(\d{1,3})\s*[集话]']:
            m = re.search(pat, base, re.IGNORECASE)
            if m:
                ep_num = int(m.group(1))
                break

        if ep_num is None or ep_num not in ep_map:
            continue

        new_base = f'{base}_{ep_map[ep_num]}'
        new_name = f'{new_base}{ext}'
        old_path = os.path.join(folder, fname)
        new_path = os.path.join(folder, new_name)
        os.rename(old_path, new_path)
        print(f'E{ep_num:02d}  {fname}  →  {new_name}')
        renamed += 1

    print(f'\n重命名 {renamed} 个文件')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('用法:')
        print('  python3 scripts/aiqiyi.py <16位tvid>                     拉弹幕')
        print('  python3 scripts/aiqiyi.py --album <16位tvid>              查整季列表')
        print('  python3 scripts/aiqiyi.py --rename <16位tvid> <文件夹>    批量重命名加tvid')
        sys.exit(1)

    if sys.argv[1] == '--rename':
        rename_folder(sys.argv[2], sys.argv[3])
        sys.exit(0)

    if sys.argv[1] == '--album':
        fetch_album(sys.argv[2])
        sys.exit(0)

    tvid = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None

    danmakus = fetch_all(tvid)
    print(f'\n共 {len(danmakus)} 条弹幕')

    for d in danmakus[:20]:
        print(f"[{d['time']:6.1f}s] {d['color']} (赞{d['likes']}) {d['text']}")
    if len(danmakus) > 20:
        print(f'... 还有 {len(danmakus) - 20} 条')

    if out_file:
        with open(out_file, 'w') as f:
            json.dump(danmakus, f, ensure_ascii=False, indent=2)
        print(f'已保存到 {out_file}')
