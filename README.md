OpenAI API Router (Cloudflare Workers)
这是一个基于 Cloudflare Workers 的轻量级 OpenAI API 路由和管理工具。它允许你通过一个统一的入口管理多个 AI 模型提供商（如 OpenAI, Azure, Claude, 或其他兼容 OpenAI 接口的中转服务），并提供了一个现代化的 Web 管理界面来配置路由规则和分发自定义 API 密钥。
![alt text](https://img.shields.io/badge/license-MIT-blue.svg)

![alt text](https://img.shields.io/badge/platform-Cloudflare%20Workers-orange.svg)


✨ 功能特点
⚡️ 高性能路由：基于 Cloudflare Edge 网络，低延迟转发。
🎨 现代化管理界面：
内置美观的 Admin 面板。
支持 自动日夜间模式（深色/浅色主题）。
移动端完美适配。
🔑 密钥管理：
后端管理：集中管理不同渠道的 API Key 和 Endpoint。
前端分发：生成自定义的 API Key 给客户端使用，保护真实 Key 不泄露。
🔀 智能分流：根据请求模型（如 gpt-4, claude-3）自动路由到配置好的不同后端。
💾 持久化存储：使用 Cloudflare KV 存储配置，无需重新部署即可实时更新。
🧪 在线测试：后台直接测试模型连通性。


🛠 部署指南
1. 准备工作
你需要一个 Cloudflare 账号。
2. 创建 KV Namespace
登录 Cloudflare Dashboard。
进入 Workers & Pages -> KV.
点击 Create a Namespace。
命名为 config_kv (或者你喜欢的名字)，点击 Add。
3. 创建 Worker
进入 Workers & Pages -> Overview -> Create Application -> Create Worker。
命名你的 Worker（例如 ai-router），点击 Deploy。
点击 Edit code。
将本项目中的 worker.js (即你的完整代码) 内容复制并覆盖编辑器中的内容。
点击 Save and deploy。
4. 绑定配置 (至关重要)
返回 Worker 的设置页面，点击 Settings -> Variables.
KV Namespace Bindings:
点击 Add binding。
Variable name: 填入 CONFIG_KV (必须完全一致)。
KV Namespace: 选择第 2 步创建的 config_kv。
Environment Variables:
点击 Add variable。
Variable name: ADMIN_PASSWORD
Value: 设置你的后台管理密码（例如 123456，请设置复杂一点）。
点击 Save and deploy。


📖 使用说明
进入管理后台
访问你的 Worker 域名（例如 https://ai-router.your-name.workers.dev/）。输入你在环境变量中设置的 ADMIN_PASSWORD 即可登录。
配置模型
在管理后台的 模型配置 页面：
模型关键词: 请求体中包含此关键词时触发路由（如 gpt-4）。
API端点: 目标服务商的地址（如 https://api.openai.com/v1 或其他中转地址）。
API密钥: 目标服务商的 Key (sk-xxxx)。
配置客户端密钥
在 认证密钥 页面添加密钥（如 my-custom-key-001）。你的用户将使用这个 Key 来请求你的 Worker。
客户端调用示例
假设你的 Worker 域名是 https://api.example.com，你配置的客户端密钥是 my-custom-key-001。

使用 cURL:
Bash
curl https://api.example.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-custom-key-001" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

  
使用 Python (OpenAI SDK):

Python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.example.com/v1",
    api_key="my-custom-key-001"
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello world"}]
)
print(response.choices[0].message.content)


⚠️ 注意事项
本程序仅作为 API 路由和转发使用，请勿用于非法用途。
建议开启 Cloudflare 的 Custom Domain 以避免 workers.dev 域名在某些网络环境下无法访问。
📄 License
MIT License
