#!/usr/bin/env python3
"""
iina-watcher.py — 通过 mpv JSON IPC 实时同步 IINA 播放进度
需要 IINA 设置: 额外的 mpv 参数 → input-ipc-server=/tmp/iina-socket
"""
import socket, json, subprocess, time, os

SOCKET_PATH = "/tmp/iina-socket"
SERVER = "http://localhost:5001"
POLL = 3  # 每 3 秒查询一次


def mpv_command(*args):
    """发送 JSON IPC 命令到 mpv"""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(SOCKET_PATH)
        msg = json.dumps({"command": list(args)}) + "\n"
        sock.sendall(msg.encode())
        resp = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk: break
            resp += chunk
            if b"\n" in chunk: break
        sock.close()
        return json.loads(resp.decode().strip())
    except Exception:
        return None


def get_property(name):
    r = mpv_command("get_property", name)
    return r["data"] if r and "data" in r else None


def save_progress(full_path, time_pos):
    basename = os.path.basename(full_path)
    # 存两份：完整路径 + 文件名，兼容 overlay 的按文件名查询
    for id_val in [full_path, basename]:
        body = json.dumps({"id": id_val, "time": time_pos})
        subprocess.run(
            ["curl", "-s", "-X", "POST", f"{SERVER}/api/progress",
             "-H", "Content-Type: application/json", "-d", body],
            capture_output=True, timeout=5
        )
    print(f"[{time.strftime('%H:%M:%S')}] {basename} → {time_pos}s")


def main():
    print("=== IINA 实时进度同步已启动 ===")
    print(f"Socket: {SOCKET_PATH}")
    print(f"服务: {SERVER}")
    print()

    last_pos = 0
    last_path = ""
    last_paused = None

    while True:
        if not os.path.exists(SOCKET_PATH):
            if last_path:
                print("[离线] 等待 IINA...")
                last_path = ""
                last_pos = 0
            time.sleep(POLL)
            continue

        path = get_property("path")
        if not path:
            time.sleep(POLL)
            continue

        pos = get_property("time-pos")
        if pos is None:
            time.sleep(POLL)
            continue

        pos = int(float(pos))

        # 文件切换了
        if path != last_path:
            last_path = path
            last_pos = 0
            # 恢复进度
            restore = get_property("time-pos")
            if restore and float(restore) > 1:
                print(f"[切换] {os.path.basename(path)}")
            # 查询是否服务端有进度记录（通过 HTTP API）
            import urllib.request
            try:
                url = f"{SERVER}/api/progress?id={urllib.parse.quote(path)}"
                resp = urllib.request.urlopen(url, timeout=3).read()
                d = json.loads(resp)
                if d.get("code") == 0 and d.get("data") and d["data"].get("time", 0) > 1:
                    t = d["data"]["time"]
                    mpv_command("set_property", "time-pos", t)
                    print(f"[恢复] 已跳转到 {t}s")
            except Exception:
                pass

        # 位置有变化才保存
        if pos > 0 and pos != last_pos:
            last_pos = pos
            save_progress(path, pos)

        # 检测暂停/播放状态变化，通知服务端
        paused = get_property("pause")
        if paused is not None and paused != last_paused:
            last_paused = paused
            body = json.dumps({"paused": paused, "time": pos})
            subprocess.run(
                ["curl", "-s", "-X", "POST", f"{SERVER}/api/iina-state",
                 "-H", "Content-Type: application/json", "-d", body],
                capture_output=True, timeout=5
            )
            print(f"[{'暂停' if paused else '播放'}] {os.path.basename(path)} @ {pos}s")

        time.sleep(POLL)


if __name__ == "__main__":
    main()