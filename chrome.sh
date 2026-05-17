#!/bin/bash

# 一步到位安装 Google Chrome 脚本

echo "开始安装 Google Chrome..."

# 更新软件源
sudo apt update

# 安装必要工具
sudo apt install -y wget gdebi-core

# 下载 Chrome 最新稳定版
wget -O google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

# 安装 Chrome
sudo gdebi -n google-chrome.deb

# 清理安装包
rm google-chrome.deb

echo "Google Chrome 安装完成！你可以在应用菜单中找到 Chrome 或者运行 google-chrome 命令启动。"