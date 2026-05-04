#!/usr/bin/env python3
"""iina-watcher.py — 通过 mpv JSON IPC 实时同步 IINA 播放进度"""
import socket, json, subprocess, time, os

SOCKET_PATH = "/tmp/iina-socket"
SERVER = "http://localhost:5001"
POLL = 3


def mpv_command(*args):
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
    for id_val in [full_path, basename]:
        body = json.dumps({"id": id_val, "time": time_pos})
        subprocess.run(
            ["curl", "-s", "-X", "POST", f"{SERVER}/api/progress",
             "-H", "Content-Type: application/json", "-d", body],
            capture_output=True, timeout=5
        )


def post_state(state):
    subprocess.run(
        ["curl", "-s", "-X", "POST", f"{SERVER}/api/iina-state",
         "-H", "Content-Type: application/json", "-d", json.dumps(state)],
        capture_output=True, timeout=5
    )


def main():
    print("=== IINA 实时进度同步已启动 ===")
    print()

    last_pos = 0
    last_path = ""
    last_paused = None
    last_path_sync = 0
    fail_count = 0
    MAX_FAIL = 5  # 连续失败超过此次数视为 socket 已死

    while True:
        if not os.path.exists(SOCKET_PATH):
            if last_path:
                print("[离线] 等待 IINA...")
                last_path = ""
                last_pos = 0
                fail_count = 0
            time.sleep(POLL)
            continue

        path = get_property("path")
        if not path:
            fail_count += 1
            if fail_count >= MAX_FAIL:
                print("[超时] socket 无响应，视为离线，等待 IINA 重启...")
                last_path = ""
                last_pos = 0
                fail_count = 0
            time.sleep(POLL)
            continue

        fail_count = 0

        pos = get_property("time-pos")
        if pos is None:
            time.sleep(POLL)
            continue

        pos = int(float(pos))
        now_ts = time.time()

        # 文件切换 or 首次连接
        if path != last_path:
            print(f"[切换] {os.path.basename(path)}")
            last_path = path
            last_pos = 0
            post_state({"paused": False, "time": 0, "path": path})
            last_path_sync = now_ts

        # 进度保存
        if pos > 0 and pos != last_pos:
            last_pos = pos
            save_progress(path, pos)

        # 暂停状态变化
        paused = get_property("pause")
        if paused is not None and paused != last_paused:
            last_paused = paused
            post_state({"paused": paused, "time": pos, "path": path})
            last_path_sync = now_ts
            print(f"[{'暂停' if paused else '播放'}] {os.path.basename(path)} @ {pos}s")

        # 每 10 秒同步一次路径
        if path and now_ts - last_path_sync > 10:
            post_state({"paused": paused or False, "time": pos, "path": path})
            last_path_sync = now_ts

        time.sleep(POLL)


if __name__ == "__main__":
    main()