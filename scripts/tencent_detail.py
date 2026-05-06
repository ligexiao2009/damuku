"""
腾讯视频 - 电视剧详情查询
用法: python3 scripts/tencent_detail.py <cid>
      python3 scripts/tencent_detail.py <cid> --vid <vid>
"""
import sys
import json
import argparse
import requests

API_URL = "https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage"
HEADERS = {
    "Referer": "https://v.qq.com/",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}


def fetch_detail(cid, vid=""):
    body = {
        "page_params": {
            "cid": cid,
            "vid": vid or None,
            "req_from": "web_vsite",
        },
        "page_bypass_params": {
            "params": {"caller_id": "3000010", "platform_id": "2"},
            "scene": "desk_detail",
            "abtest_bypass_id": "tencent_detail_py",
        },
        "page_context": {},
    }

    url = f"{API_URL}?vdevice_guid=tencent_detail_py&video_appid=3000010&vversion_name=8.5.96&vversion_platform=2"

    resp = requests.post(url, json=body, headers=HEADERS, timeout=15)
    data = resp.json()
    if data.get("ret") != 0:
        print(f"API 返回错误: ret={data.get('ret')}", file=sys.stderr)
        return None

    card_list = data.get("data", {}).get("CardList")
    if not card_list:
        print("未获取到数据", file=sys.stderr)
        return None

    return parse_cards(card_list)


def parse_cards(card_list):
    result = {
        "title": "",
        "description": "",
        "poster": "",
        "year": "",
        "area": "",
        "genres": [],
        "episode_all": 0,
        "hotval": "",
        "score": "",
        "douban_score": "",
        "episodes": [],
    }

    def walk(cards):
        for card in cards:
            ctype = card.get("type", "")
            params = card.get("params", {})

            if ctype == "pc_introduction":
                result["title"] = params.get("title") or result["title"]
                result["description"] = params.get("cover_description") or result["description"]
                result["poster"] = params.get("new_pic_hz") or result["poster"]
                result["year"] = params.get("year") or result["year"]
                result["area"] = params.get("area_name") or result["area"]
                result["episode_all"] = int(params.get("episode_all", 0)) or result["episode_all"]
                result["hotval"] = params.get("hotval") or result["hotval"]

                genres = []
                mg = params.get("main_genres")
                if mg:
                    genres.append(mg)
                sg = params.get("sub_genre", "")
                genres.extend([g for g in sg.split(",") if g])
                result["genres"] = list(set(genres))

                try:
                    si = json.loads(params.get("score_info", "{}"))
                    result["score"] = si.get("video_score") or result["score"]
                    result["douban_score"] = si.get("douban_score") or result["douban_score"]
                except (json.JSONDecodeError, TypeError):
                    pass

            if ctype == "detail_score_discussion_style":
                result["score"] = result["score"] or params.get("score", "")
                result["douban_score"] = result["douban_score"] or params.get("douban_rating", "")

            if ctype == "pc_web_episode_list":
                eps = []
                for ck in card.get("children_list", {}):
                    for sc in card["children_list"][ck].get("cards", []):
                        p = sc.get("params", {})
                        if p.get("vid"):
                            eps.append({
                                "title": p.get("title", ""),
                                "vid": p["vid"],
                                "duration": int(p.get("duration", 0) or 0),
                            })
                if eps:
                    eps.sort(key=lambda e: float(e["title"]) if e["title"].replace(".","").isdigit() else 9999)
                    result["episodes"] = eps

            for ck in card.get("children_list", {}):
                walk(card["children_list"][ck].get("cards", []))

    walk(card_list)
    return result


def print_detail(d):
    print(f"剧名: {d['title']}")
    print(f"年份: {d['year']}  地区: {d['area']}  类型: {' / '.join(d['genres'])}")
    print(f"集数: {d['episode_all']}  热度: {d['hotval']}")
    print(f"评分: 腾讯 {d['score']}  豆瓣 {d['douban_score']}")
    print(f"封面: {d['poster']}")
    print(f"简介: {d['description'][:200]}...")
    print(f"\n分集列表 ({len(d['episodes'])} 集):")
    for ep in d["episodes"]:
        m, s = divmod(ep["duration"], 60)
        dur = f"{m}:{s:02d}" if m else f"{s}s"
        print(f"  {ep['title']:>4s}  {ep['vid']}  {dur}")


def main():
    parser = argparse.ArgumentParser(description="腾讯视频电视剧详情查询")
    parser.add_argument("cid", help="腾讯视频专辑 ID (cid), 从 https://v.qq.com/x/cover/{cid}.html 获取")
    parser.add_argument("--vid", default="", help="可选: 某个分集的 vid, 可获取更完整数据")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")
    args = parser.parse_args()

    detail = fetch_detail(args.cid, args.vid)
    if not detail:
        sys.exit(1)

    if args.json:
        print(json.dumps(detail, ensure_ascii=False, indent=2))
    else:
        print_detail(detail)


if __name__ == "__main__":
    main()
