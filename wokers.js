// 全局变量
var parsedModelConfigs = null;
var parsedAuthKeys = null;

// 环境变量和KV操作函数
async function initEnvVariables(env) {
  try {
    // 首先尝试从KV存储中获取配置
    const kvModelConfigs = await env.CONFIG_KV.get('MODEL_CONFIGS');
    const kvAuthKeys = await env.CONFIG_KV.get('AUTH_KEYS');
    const adminPassword = await env.CONFIG_KV.get('ADMIN_PASSWORD');
    
    // 如果KV中有新的配置格式，使用KV中的
    if (kvModelConfigs) {
      parsedModelConfigs = JSON.parse(kvModelConfigs);
    } else {
      // 尝试从旧的配置格式转换
      const kvModelMappings = await env.CONFIG_KV.get('MODEL_MAPPINGS');
      const kvApiKeys = await env.CONFIG_KV.get('API_KEYS');
      
      if (kvModelMappings && kvApiKeys) {
        const modelMappings = JSON.parse(kvModelMappings);
        const apiKeys = JSON.parse(kvApiKeys);
        
        // 将旧配置转换为新格式
        parsedModelConfigs = {};
        for (const [keyword, endpoint] of Object.entries(modelMappings)) {
          parsedModelConfigs[keyword] = {
            endpoint: endpoint,
            apiKey: apiKeys[endpoint] || ""
          };
        }
        
        // 保存新格式到KV
        await env.CONFIG_KV.put('MODEL_CONFIGS', JSON.stringify(parsedModelConfigs));
      } else if (env.MODEL_MAPPINGS && env.API_KEYS) {
        // 如果KV中没有，但环境变量中有，尝试转换
        const modelMappings = JSON.parse(env.MODEL_MAPPINGS);
        const apiKeys = JSON.parse(env.API_KEYS);
        
        parsedModelConfigs = {};
        for (const [keyword, endpoint] of Object.entries(modelMappings)) {
          parsedModelConfigs[keyword] = {
            endpoint: endpoint,
            apiKey: apiKeys[endpoint] || ""
          };
        }
        
        // 保存到KV
        await env.CONFIG_KV.put('MODEL_CONFIGS', JSON.stringify(parsedModelConfigs));
      }
    }
    
    if (kvAuthKeys) {
      parsedAuthKeys = JSON.parse(kvAuthKeys);
    } else if (env.AUTH_KEYS) {
      parsedAuthKeys = JSON.parse(env.AUTH_KEYS);
      // 将环境变量中的配置同步到KV
      await env.CONFIG_KV.put('AUTH_KEYS', env.AUTH_KEYS);
    }
    
    // 如果没有设置管理员密码，使用环境变量中的并存储到KV
    if (!adminPassword && env.ADMIN_PASSWORD) {
      await env.CONFIG_KV.put('ADMIN_PASSWORD', env.ADMIN_PASSWORD);
    }
    
    if (!parsedModelConfigs || !parsedAuthKeys) {
      const missing = [];
      if (!parsedModelConfigs) missing.push("MODEL_CONFIGS");
      if (!parsedAuthKeys) missing.push("AUTH_KEYS");
      throw new Error(`缺少必要的配置: ${missing.join(", ")}`);
    }
  } catch (error) {
    console.error("Error parsing environment variables:", error);
    throw new Error(`配置解析错误: ${error.message}`);
  }
}

// 主要的fetch处理器
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 提供静态资源 (CSS, JS)
    if (url.pathname === '/styles.css') {
      return new Response(getStyles(), {
        headers: { 'Content-Type': 'text/css' }
      });
    }
    
    if (url.pathname === '/script.js') {
      return new Response(getScript(), {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    // 处理API请求
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url);
    }
    
    // 根路径返回管理界面
    if (url.pathname === '/' || url.pathname === '/admin') {
      try {
        // 检查是否需要登录
        const adminPassword = await env.CONFIG_KV.get('ADMIN_PASSWORD');
        if (!adminPassword) {
          // 如果没有设置密码，使用环境变量中的
          return new Response(getLoginPage(false), {
            headers: { 'Content-Type': 'text/html' }
          });
        }
        
        // 检查是否已登录
        const cookies = request.headers.get('Cookie') || '';
        const isAuthenticated = cookies.includes(`auth_token=${adminPassword}`);
        
        if (isAuthenticated) {
          // 已登录，显示管理界面
          const modelConfigs = await env.CONFIG_KV.get('MODEL_CONFIGS');
          const authKeys = await env.CONFIG_KV.get('AUTH_KEYS');
          
          return new Response(getAdminPage(modelConfigs, authKeys), {
            headers: { 'Content-Type': 'text/html' }
          });
        } else {
          // 未登录，显示登录页面
          return new Response(getLoginPage(true), {
            headers: { 'Content-Type': 'text/html' }
          });
        }
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }
    
    // 处理原始的API路由功能
    try {
      await initEnvVariables(env);
    } catch (error) {
      return new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "configuration_error"
        }
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    
    if (request.method === "OPTIONS") {
      return handleCors();
    }
    
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        message: "OpenAI API Router is running"
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    
    try {
      const authHeader = request.headers.get("Authorization") || "";
      const apiKey = authHeader.replace("Bearer ", "").trim();
      
      if (!isValidApiKey(apiKey)) {
        return new Response(JSON.stringify({
          error: {
            message: "请输入WorkersRouting中自定义apikey",
            type: "invalid_request_error",
            code: "invalid_api_key"
          }
        }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
      
      const requestBody = await request.json();
      const { targetEndpoint, targetApiKey } = determineTargetApi(requestBody);
      
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${targetApiKey}`);
      
      for (const [key, value] of request.headers.entries()) {
        if (!["host", "content-length", "authorization"].includes(key.toLowerCase())) {
          headers.set(key, value);
        }
      }
      
      const apiPath = url.pathname;
      return await forwardRequest(targetEndpoint, apiPath, headers, requestBody);
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "server_error"
        }
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};

// 处理API请求
async function handleApiRequest(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  
  // 登录API
  if (path === '/api/login' && method === 'POST') {
    try {
      const { password } = await request.json();
      const adminPassword = await env.CONFIG_KV.get('ADMIN_PASSWORD');
      
      if (password === adminPassword) {
        // 登录成功，设置cookie
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth_token=${adminPassword}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` // 1小时过期
          }
        });
      } else {
        return new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401 });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }
  
  // 登出API
  if (path === '/api/logout') {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' // 立即过期
      }
    });
  }
  
  // 测试模型API
  if (path === '/api/test-model' && method === 'POST') {
    try {
      // 验证是否已登录
      const cookies = request.headers.get('Cookie') || '';
      const adminPassword = await env.CONFIG_KV.get('ADMIN_PASSWORD');
      const isAuthenticated = cookies.includes(`auth_token=${adminPassword}`);
      
      if (!isAuthenticated) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
      
      const { modelKeyword, testMessage } = await request.json();
      
      // 确保配置已初始化
      await initEnvVariables(env);
      
      // 查找模型配置
      const modelConfig = parsedModelConfigs[modelKeyword];
      if (!modelConfig) {
        return new Response(JSON.stringify({ error: 'Model configuration not found' }), { status: 404 });
      }
      
      // 创建测试请求
      const testRequest = {
        model: modelKeyword,
        messages: [
          { role: "user", content: testMessage || "Hello, please respond briefly." }
        ],
        max_tokens: 50
      };
      
      // 发送测试请求
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", `Bearer ${modelConfig.apiKey}`);
      
      const cleanEndpoint = modelConfig.endpoint.replace(/\/$/, "");
      const targetUrl = `${cleanEndpoint}/chat/completions`;
      
      const testResponse = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(testRequest)
      });
      
      if (testResponse.ok) {
        const result = await testResponse.json();
        return new Response(JSON.stringify({ 
          success: true, 
          response: result.choices[0].message.content 
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        const errorData = await testResponse.text();
        return new Response(JSON.stringify({ 
          success: false, 
          error: `API Error (${testResponse.status}): ${errorData}` 
        }), {
          status: testResponse.status,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Error testing model:', error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message 
      }), { status: 500 });
    }
  }
  
  // 配置API
  if (path === '/api/config') {
    // 验证是否已登录
    const cookies = request.headers.get('Cookie') || '';
    const adminPassword = await env.CONFIG_KV.get('ADMIN_PASSWORD');
    const isAuthenticated = cookies.includes(`auth_token=${adminPassword}`);
    
    if (!isAuthenticated) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    
    // GET请求：获取配置
    if (method === 'GET') {
      try {
        const modelConfigs = await env.CONFIG_KV.get('MODEL_CONFIGS');
        const authKeys = await env.CONFIG_KV.get('AUTH_KEYS');
        
        return new Response(JSON.stringify({
          modelConfigs: modelConfigs ? JSON.parse(modelConfigs) : {},
          authKeys: authKeys ? JSON.parse(authKeys) : []
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }
    
    // PUT请求：更新配置
    if (method === 'PUT') {
      try {
        const { modelConfigs, authKeys } = await request.json();
        
        // 更新KV存储
        console.log('Saving MODEL_CONFIGS to KV:', JSON.stringify(modelConfigs));
        await env.CONFIG_KV.put('MODEL_CONFIGS', JSON.stringify(modelConfigs));
        
        console.log('Saving AUTH_KEYS to KV:', JSON.stringify(authKeys));
        await env.CONFIG_KV.put('AUTH_KEYS', JSON.stringify(authKeys));
        
        // 验证数据是否正确保存
        const savedModelConfigs = await env.CONFIG_KV.get('MODEL_CONFIGS');
        const savedAuthKeys = await env.CONFIG_KV.get('AUTH_KEYS');
        
        console.log('Verification - MODEL_CONFIGS saved correctly:', savedModelConfigs === JSON.stringify(modelConfigs));
        console.log('Verification - AUTH_KEYS saved correctly:', savedAuthKeys === JSON.stringify(authKeys));
        
        // 更新全局变量
        parsedModelConfigs = modelConfigs;
        parsedAuthKeys = authKeys;
        
        return new Response(JSON.stringify({ 
          success: true,
          message: '配置已成功保存到KV存储'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error saving configuration to KV:', error);
        return new Response(JSON.stringify({ 
          error: error.message,
          details: '保存配置到KV时出错'
        }), { status: 500 });
      }
    }
    
    // 其他方法不允许
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  
  return new Response('Not Found', { status: 404 });
}

// 获取登录页面HTML
function getLoginPage(requireAuth) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - API Router管理</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="login-body">
  <div class="login-container">
    <div class="login-card">
      <div class="logo-area">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="login-logo"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      </div>
      <h1>API Router</h1>
      <p class="login-subtitle">请输入管理员密码以继续</p>
      <form id="loginForm">
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required placeholder="您的访问密码">
        </div>
        <button type="submit" class="btn btn-primary btn-block">登录系统</button>
      </form>
      <div id="errorMessage" class="error-message" style="display: none;"></div>
    </div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorMessage = document.getElementById('errorMessage');
      const submitBtn = e.target.querySelector('button[type="submit"]');
      
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-sm"></span> 登录中...';
      
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          window.location.href = '/admin';
        } else {
          errorMessage.textContent = data.error || '登录失败';
          errorMessage.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = '登录系统';
        }
      } catch (error) {
        errorMessage.textContent = '网络错误，请稍后重试';
        errorMessage.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = '登录系统';
      }
    });
  </script>
</body>
</html>`;
}

// 获取管理页面HTML
function getAdminPage(modelConfigs, authKeys) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Router 控制台</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" type="image/x-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
</head>
<body>
  <!-- 移动端菜单按钮 -->
  <button id="mobileMenuBtn" class="mobile-menu-btn">
    <span></span>
    <span></span>
    <span></span>
  </button>

  <!-- 侧边栏 -->
  <aside id="sidebar" class="sidebar">
    <div class="sidebar-header">
      <div class="brand">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <span>Router Admin</span>
      </div>
      <button id="themeToggle" class="theme-toggle" title="切换主题">
        <!-- Sun Icon -->
        <svg class="sun-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
        <!-- Moon Icon -->
        <svg class="moon-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      </button>
    </div>
    <nav class="sidebar-nav">
      <a href="#" class="nav-link active" data-tab="model-configs">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        模型配置
      </a>
      <a href="#" class="nav-link" data-tab="auth-keys">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        认证密钥
      </a>
      <div class="nav-divider"></div>
      <a href="#" class="nav-link danger-hover" id="logoutLink">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
        退出登录
      </a>
    </nav>
    <div class="sidebar-footer">
      <div class="export-import">
        <button id="exportBtn" class="btn btn-outline btn-sm btn-block">导出配置</button>
        <button id="importBtn" class="btn btn-outline btn-sm btn-block">导入配置</button>
        <input type="file" id="importFile" style="display: none;" accept=".json">
      </div>
    </div>
  </aside>

  <!-- 主内容区 -->
  <main class="main-content">
    <header class="header">
      <h1>控制台</h1>
      <div class="header-actions">
        <span class="user-badge">Admin</span>
        <button id="mobileLogoutBtn" class="btn btn-outline btn-sm mobile-only">退出</button>
      </div>
    </header>
    
    <div class="content-area">
      <!-- 模型配置标签页 -->
      <div id="model-configs" class="tab-content active">
        <div class="content-header">
          <div class="title-group">
            <h2>模型配置</h2>
            <p class="subtitle">管理AI模型的转发规则和API密钥</p>
          </div>
          <div class="header-buttons">
            <button class="btn btn-primary add-btn" data-target="model-configs">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              添加模型
            </button>
            <div class="btn-group">
                <button id="saveBtn" class="btn btn-success">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                </svg>
                保存
                </button>
                <button id="resetBtn" class="btn btn-outline">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="1 4 1 10 7 10"></polyline>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                </svg>
                重置
                </button>
            </div>
          </div>
        </div>
        <div class="table-container">
        
          <table class="data-table">
            <thead>
              <tr>
                <th width="20%">模型关键词</th>
                <th width="35%">API端点</th>
                <th width="20%">API密钥</th>
                <th width="25%">操作</th>
              </tr>
            </thead>
            <tbody id="modelConfigsTable">
              <!-- 数据将通过JavaScript动态加载 -->
            </tbody>
          </table>
          <div id="modelConfigsEmpty" class="empty-state" style="display: none;">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
            <p>暂无模型配置</p>
            <button class="btn btn-primary btn-sm add-btn" data-target="model-configs">立即添加</button>
          </div>
        </div>
      </div>
      
      <!-- 认证密钥标签页 -->
      <div id="auth-keys" class="tab-content">
        <div class="content-header">
          <div class="title-group">
            <h2>认证密钥</h2>
            <p class="subtitle">管理允许访问此服务的客户端密钥</p>
          </div>
          <div class="header-buttons">
            <button class="btn btn-primary add-btn" data-target="auth-keys">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              添加密钥
            </button>
             <div class="btn-group">
                <button id="saveBtnAuth" class="btn btn-success">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                </svg>
                保存
                </button>
                <button id="resetBtnAuth" class="btn btn-outline">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="1 4 1 10 7 10"></polyline>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                </svg>
                重置
                </button>
            </div>
          </div>
        </div>
        <div class="table-container">
         
          <table class="data-table">
            <thead>
              <tr>
                <th width="70%">密钥</th>
                <th width="30%">操作</th>
              </tr>
            </thead>
            <tbody id="authKeysTable">
              <!-- 数据将通过JavaScript动态加载 -->
            </tbody>
          </table>
          <div id="authKeysEmpty" class="empty-state" style="display: none;">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
            <p>暂无认证密钥</p>
            <button class="btn btn-primary btn-sm add-btn" data-target="auth-keys">立即添加</button>
          </div>
        </div>
      </div>
    </div>
  </main>
    
  <!-- 模态框 -->
  <div id="modal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h2 id="modalTitle">添加配置</h2>
        <button class="close-btn">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <form id="modalForm">
        <!-- 表单内容将根据类型动态生成 -->
      </form>
    </div>
  </div>
  
  <!-- 测试模型模态框 -->
  <div id="testModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>测试模型连接</h2>
        <button class="close-btn">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <form id="testForm">
        <div class="form-group">
          <label for="testModel">选择模型</label>
          <div class="select-wrapper">
            <select id="testModel" required>
              <!-- 选项将通过JavaScript动态填充 -->
            </select>
          </div>
        </div>
        <div class="form-group">
          <label for="testMessage">测试消息</label>
          <textarea id="testMessage" rows="3" placeholder="输入测试消息...">Hello, please respond briefly.</textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline cancel-btn">取消</button>
          <button type="submit" class="btn btn-primary">测试</button>
        </div>
      </form>
      <div id="testResult" class="test-result"></div>
    </div>
  </div>
  
  <!-- 通知 -->
  <div id="notification" class="notification"></div>
  
  <!-- 加载遮罩 -->
  <div id="loadingOverlay" class="loading-overlay" style="display: none;">
    <div class="spinner-container">
      <div class="spinner"></div>
      <p>处理中...</p>
    </div>
  </div>
  
  <script src="/script.js"></script>
</body>
</html>`;
}

// 获取CSS样式
function getStyles() {
  return `/* CSS变量定义 - 现代配色方案 */
:root {
  /* 基础色板 */
  --primary-50: #eef2ff;
  --primary-100: #e0e7ff;
  --primary-500: #6366f1;
  --primary-600: #4f46e5;
  --primary-700: #4338ca;
  
  --slate-50: #f8fafc;
  --slate-100: #f1f5f9;
  --slate-200: #e2e8f0;
  --slate-300: #cbd5e1;
  --slate-400: #94a3b8;
  --slate-500: #64748b;
  --slate-600: #475569;
  --slate-700: #334155;
  --slate-800: #1e293b;
  --slate-900: #0f172a;

  /* 语义化变量 (Light Mode) */
  --bg-body: var(--slate-50);
  --bg-card: #ffffff;
  --bg-sidebar: #ffffff;
  --bg-input: #ffffff;
  --bg-hover: var(--slate-50);
  
  --text-main: var(--slate-900);
  --text-secondary: var(--slate-500);
  --text-inverted: #ffffff;
  
  --border-color: var(--slate-200);
  --border-focus: var(--primary-500);
  
  --primary-color: var(--primary-600);
  --primary-hover: var(--primary-700);
  
  --success-color: #10b981;
  --warning-color: #f59e0b;
  --error-color: #ef4444;
  --error-bg: #fef2f2;
  --success-bg: #ecfdf5;
  
  /* 阴影 */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  
  --sidebar-width: 260px;
  --header-height: 64px;
  --transition-speed: 0.2s;
  --radius: 8px;
}

/* 暗黑模式变量 (Dark Mode) */
body.dark-mode {
  --bg-body: var(--slate-900);
  --bg-card: var(--slate-800);
  --bg-sidebar: var(--slate-900); /* 侧边栏与背景一致或略深 */
  --bg-input: var(--slate-900);
  --bg-hover: var(--slate-700);
  
  --text-main: var(--slate-100);
  --text-secondary: var(--slate-400);
  
  --border-color: var(--slate-700);
  
  --primary-color: var(--primary-500);
  --primary-hover: var(--primary-600);
  
  --error-bg: rgba(239, 68, 68, 0.2);
  --success-bg: rgba(16, 185, 129, 0.2);
  
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
}

/* 全局重置 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--text-main);
  background-color: var(--bg-body);
  line-height: 1.5;
  font-size: 14px;
  transition: background-color var(--transition-speed), color var(--transition-speed);
}

/* 链接和SVG */
a { text-decoration: none; color: inherit; }
svg { flex-shrink: 0; }

/* 登录页面优化 */
.login-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
}
.dark-mode .login-body {
  background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
}

.login-container {
  width: 100%;
  max-width: 400px;
  padding: 20px;
}

.login-card {
  background: var(--bg-card);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  padding: 40px 32px;
  text-align: center;
}

.logo-area {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  background-color: var(--primary-50);
  color: var(--primary-600);
  border-radius: 50%;
  margin-bottom: 24px;
}
.dark-mode .logo-area {
  background-color: rgba(99, 102, 241, 0.2);
  color: var(--primary-500);
}

.login-card h1 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-main);
}

.login-subtitle {
  margin-bottom: 32px;
  color: var(--text-secondary);
}

/* 侧边栏样式 */
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  width: var(--sidebar-width);
  height: 100vh;
  background-color: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  z-index: 50;
  transition: transform var(--transition-speed);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  height: var(--header-height);
  padding: 0 24px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 18px;
  color: var(--primary-color);
}

.sidebar-nav {
  flex: 1;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-link {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  color: var(--text-secondary);
  font-weight: 500;
  border-radius: var(--radius);
  transition: all var(--transition-speed);
}

.nav-link:hover {
  background-color: var(--bg-hover);
  color: var(--text-main);
}

.nav-link.active {
  background-color: var(--primary-50);
  color: var(--primary-700);
}
.dark-mode .nav-link.active {
  background-color: rgba(99, 102, 241, 0.15);
  color: var(--primary-500);
}

.nav-link svg {
  margin-right: 12px;
}

.nav-divider {
  height: 1px;
  background-color: var(--border-color);
  margin: 16px 0;
}

.danger-hover:hover {
  background-color: var(--error-bg);
  color: var(--error-color);
}

.sidebar-footer {
  padding: 20px;
  border-top: 1px solid var(--border-color);
}

/* 主题切换按钮 */
.theme-toggle {
  background: none;
  border: 1px solid var(--border-color);
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all var(--transition-speed);
}
.theme-toggle:hover {
  background-color: var(--bg-hover);
  color: var(--text-main);
}

.sun-icon { display: block; }
.moon-icon { display: none; }
body.dark-mode .sun-icon { display: none; }
body.dark-mode .moon-icon { display: block; }

/* 主内容区域 */
.main-content {
  margin-left: var(--sidebar-width);
  min-height: 100vh;
  transition: margin-left var(--transition-speed);
}

.header {
  height: var(--header-height);
  padding: 0 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: var(--bg-body); /* 保持与背景一致或透明 */
  position: sticky;
  top: 0;
  z-index: 40;
}

.header h1 {
  font-size: 20px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.user-badge {
  padding: 4px 12px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.content-area {
  padding: 32px;
  max-width: 1200px;
  margin: 0 auto;
}

.tab-content {
  display: none;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.tab-content.active {
  display: block;
}

.content-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 20px;
}

.title-group h2 {
  font-size: 24px;
  margin-bottom: 4px;
}
.subtitle {
  color: var(--text-secondary);
}

.header-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.btn-group {
    display: flex;
    gap: 8px;
}

/* 按钮系统 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  gap: 8px;
  line-height: 1.25;
}

.btn-block { width: 100%; }

.btn:active { transform: translateY(1px); }
.btn:focus { outline: none; box-shadow: 0 0 0 2px var(--border-color); }

.btn-primary {
  background-color: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}
.btn-primary:hover {
  background-color: var(--primary-hover);
  border-color: var(--primary-hover);
}
.btn-primary:focus { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); }

.btn-outline {
  background-color: transparent;
  color: var(--text-main);
  border-color: var(--border-color);
  background-color: var(--bg-card);
}
.btn-outline:hover {
  border-color: var(--slate-400);
  background-color: var(--bg-hover);
}

.btn-success {
  background-color: var(--success-color);
  color: white;
}
.btn-success:hover { filter: brightness(90%); }

.btn-danger {
  background-color: transparent;
  color: var(--error-color);
  border-color: rgba(239, 68, 68, 0.3);
}
.btn-danger:hover {
  background-color: var(--error-bg);
  border-color: var(--error-color);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

/* 表格容器 */
.table-container {
  background: var(--bg-card);
  border-radius: 12px;
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th {
  background-color: var(--slate-50);
  color: var(--text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 12px;
  letter-spacing: 0.05em;
  padding: 16px 24px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}
.dark-mode .data-table th {
  background-color: var(--slate-800);
}

.data-table td {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-main);
  vertical-align: middle;
}

.data-table tbody tr:last-child td { border-bottom: none; }

.data-table tbody tr {
    transition: background-color 0.2s;
}
.data-table tbody tr:hover {
    background-color: var(--bg-hover);
}

.actions {
  display: flex;
  gap: 8px;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 64px 24px;
  color: var(--text-secondary);
}
.empty-state svg {
  color: var(--slate-300);
  margin-bottom: 16px;
}
.dark-mode .empty-state svg {
  color: var(--slate-600);
}

/* 表单元素 */
.form-group { margin-bottom: 24px; }

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  color: var(--text-main);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 10px 14px;
  background-color: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-main);
  font-size: 14px;
  transition: all 0.2s;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.form-group small {
  display: block;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

/* 模态框 */
.modal {
  display: none;
  position: fixed;
  z-index: 1000;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.modal-content {
  background-color: var(--bg-card);
  margin: 80px auto;
  padding: 0;
  border-radius: 12px;
  width: 90%;
  max-width: 540px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-color);
  animation: modalFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalFadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}
.modal-header h2 { font-size: 18px; margin: 0; }

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
}
.close-btn:hover { background-color: var(--bg-hover); color: var(--text-main); }

#modalForm, #testForm { padding: 24px; }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 32px;
}

/* 测试结果区域 */
.test-result {
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  background-color: var(--bg-body);
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}
.test-result.success { color: var(--success-color); background-color: var(--success-bg); }
.test-result.error { color: var(--error-color); background-color: var(--error-bg); }

/* 加载动画 */
.spinner, .spinner-sm {
  border: 3px solid rgba(0,0,0,0.1);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
.spinner { width: 40px; height: 40px; margin: 0 auto 16px; }
.spinner-sm { width: 16px; height: 16px; display: inline-block; border-width: 2px; }

.dark-mode .spinner { border-color: rgba(255,255,255,0.1); border-top-color: var(--primary-color); }

@keyframes spin { to { transform: rotate(360deg); } }

.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
}
.dark-mode .loading-overlay { background-color: rgba(15, 23, 42, 0.8); }

.spinner-container {
  background: var(--bg-card);
  padding: 24px 40px;
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  text-align: center;
  border: 1px solid var(--border-color);
}

/* 通知 */
.notification {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 20px;
  border-radius: 8px;
  color: white;
  font-weight: 500;
  z-index: 2001;
  opacity: 0;
  transform: translateY(20px);
  transition: all 0.3s;
  box-shadow: var(--shadow-md);
}
.notification.show { opacity: 1; transform: translateY(0); }
.notification.success { background-color: var(--success-color); }
.notification.error { background-color: var(--error-color); }
.notification.warning { background-color: var(--warning-color); }

.error-message {
  color: var(--error-color);
  margin-top: 16px;
  padding: 12px;
  background-color: var(--error-bg);
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

/* 移动端菜单按钮 */
.mobile-menu-btn {
  display: none;
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 60;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  width: 40px;
  height: 40px;
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 5px;
}
.mobile-menu-btn span {
  width: 20px;
  height: 2px;
  background-color: var(--text-main);
  transition: 0.3s;
}
.mobile-menu-btn.active span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.mobile-menu-btn.active span:nth-child(2) { opacity: 0; }
.mobile-menu-btn.active span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

/* 响应式适配 */
@media (max-width: 1024px) {
  .content-area { padding: 24px; }
}

@media (max-width: 768px) {
  :root { --sidebar-width: 0px; }
  
  .sidebar { width: 260px; transform: translateX(-100%); }
  .sidebar.active { transform: translateX(0); box-shadow: 2px 0 20px rgba(0,0,0,0.2); }
  
  .main-content { margin-left: 0; }
  
  .mobile-menu-btn { display: flex; }
  .mobile-only { display: inline-flex; }
  
  .header { padding-left: 60px; padding-right: 16px; }
  
  .content-header { flex-direction: column; align-items: flex-start; gap: 16px; }
  .header-buttons { width: 100%; }
  .header-buttons .btn { flex: 1; }
  .btn-group { flex: 1; }
  
  .mobile-table-hint { display: block; padding: 8px; font-size: 12px; color: var(--text-secondary); background: var(--slate-50); text-align: center; border-bottom: 1px solid var(--border-color); }
  .dark-mode .mobile-table-hint { background: var(--slate-800); }
  
  .data-table { display: block; overflow-x: auto; white-space: nowrap; }
  .data-table th, .data-table td { padding: 12px 16px; }
  
  .modal-content { width: 95%; margin: 20px auto; }
}`;
}

// 获取JavaScript代码
function getScript() {
  return `// 全局变量
let currentConfig = {
  modelConfigs: {},
  authKeys: []
};

let isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
  // 初始化暗黑模式
  initDarkMode();
  
  // 加载配置
  loadConfig();
  
  // 设置事件监听器
  setupEventListeners();
  
  // 初始化移动端菜单
  initMobileMenu();
  
  // 检查移动设备
  checkMobileDevice();
});

// 初始化暗黑模式
function initDarkMode() {
  // 检查本地存储中是否有用户偏好设置
  const savedTheme = localStorage.getItem('theme');
  
  if (savedTheme === 'dark' || (!savedTheme && isDarkMode)) {
    document.body.classList.add('dark-mode');
  }
  
  // 监听系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) {
      if (e.matches) {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
    }
  });
}

// 初始化移动端菜单
function initMobileMenu() {
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  
  // 点击菜单按钮
  mobileMenuBtn.addEventListener('click', function() {
    this.classList.toggle('active');
    sidebar.classList.toggle('active');
  });
  
  // 点击侧边栏外部关闭
  document.addEventListener('click', function(event) {
    if (window.innerWidth <= 768 && 
        !sidebar.contains(event.target) && 
        !mobileMenuBtn.contains(event.target) && 
        sidebar.classList.contains('active')) {
      sidebar.classList.remove('active');
      mobileMenuBtn.classList.remove('active');
    }
  });
  
  // 窗口大小变化时重置菜单状态
  window.addEventListener('resize', function() {
    if (window.innerWidth > 768) {
      sidebar.classList.remove('active');
      mobileMenuBtn.classList.remove('active');
    }
  });
}

// 检查移动设备
function checkMobileDevice() {
  if (window.innerWidth <= 768) {
    document.body.classList.add('mobile-device');
  }
  
  // 监听窗口大小变化
  window.addEventListener('resize', function() {
    if (window.innerWidth <= 768) {
      document.body.classList.add('mobile-device');
    } else {
      document.body.classList.remove('mobile-device');
    }
  });
}

// 设置事件监听器
function setupEventListeners() {
  // 侧边栏导航
  document.querySelectorAll('.nav-link[data-tab]').forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const tabId = this.getAttribute('data-tab');
      
      // 更新导航状态
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      this.classList.add('active');
      
      // 更新标签内容显示
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      
      // 移动端关闭菜单
      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('active');
        document.getElementById('mobileMenuBtn').classList.remove('active');
      }
    });
  });
  
  // 登出链接和按钮
  const logoutLink = document.getElementById('logoutLink');
  if(logoutLink) logoutLink.addEventListener('click', logout);
  
  const mobileLogoutBtn = document.getElementById('mobileLogoutBtn');
  if(mobileLogoutBtn) mobileLogoutBtn.addEventListener('click', logout);
  
  // 主题切换
  const themeToggle = document.getElementById('themeToggle');
  if(themeToggle) themeToggle.addEventListener('click', toggleTheme);
  
  // 添加按钮
  document.querySelectorAll('.add-btn').forEach(button => {
    button.addEventListener('click', function() {
      const target = this.getAttribute('data-target');
      openModal(target, null);
    });
  });
  
  // 关闭模态框
  document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      this.closest('.modal').style.display = 'none';
    });
  });
  
  // 取消按钮
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      this.closest('.modal').style.display = 'none';
    });
  });
  
  // 点击模态框外部关闭
  window.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal')) {
      event.target.style.display = 'none';
    }
  });
  
  // 保存配置
  const saveBtn = document.getElementById('saveBtn');
  if(saveBtn) saveBtn.addEventListener('click', saveConfig);
  
  const saveBtnAuth = document.getElementById('saveBtnAuth');
  if(saveBtnAuth) saveBtnAuth.addEventListener('click', saveConfig);
  
  // 重置配置
  const resetBtn = document.getElementById('resetBtn');
  if(resetBtn) resetBtn.addEventListener('click', loadConfig);
  
  const resetBtnAuth = document.getElementById('resetBtnAuth');
  if(resetBtnAuth) resetBtnAuth.addEventListener('click', loadConfig);
  
  // 导出配置
  const exportBtn = document.getElementById('exportBtn');
  if(exportBtn) exportBtn.addEventListener('click', exportConfig);
  
  // 导入配置
  const importBtn = document.getElementById('importBtn');
  if(importBtn) {
    importBtn.addEventListener('click', function() {
      document.getElementById('importFile').click();
    });
  }
  
  const importFile = document.getElementById('importFile');
  if(importFile) importFile.addEventListener('change', importConfig);
  
  // 测试表单提交
  const testForm = document.getElementById('testForm');
  if(testForm) testForm.addEventListener('submit', testModel);
}

// 切换主题
function toggleTheme() {
  const body = document.body;
  
  if (body.classList.contains('dark-mode')) {
    body.classList.remove('dark-mode');
    localStorage.setItem('theme', 'light');
  } else {
    body.classList.add('dark-mode');
    localStorage.setItem('theme', 'dark');
  }
}

// 加载配置
async function loadConfig() {
  try {
    showLoading();
    const response = await fetch('/api/config');
    if (!response.ok) {
      throw new Error('Failed to load configuration');
    }
    
    currentConfig = await response.json();
    
    // 更新表格
    updateModelConfigsTable();
    updateAuthKeysTable();
    
    hideLoading();
  } catch (error) {
    hideLoading();
    // 登录页面不需要显示此错误
    if(!document.querySelector('.login-body')) {
      showNotification('加载配置失败: ' + error.message, 'error');
    }
  }
}

// 更新模型配置表格
function updateModelConfigsTable() {
  const table = document.getElementById('modelConfigsTable');
  if(!table) return;
  
  const emptyState = document.getElementById('modelConfigsEmpty');
  
  // 清空表格
  table.innerHTML = '';
  
  // 检查是否有数据
  if (Object.keys(currentConfig.modelConfigs).length === 0) {
    table.parentElement.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  
  table.parentElement.style.display = 'table'; // Fix display
  if(window.innerWidth <= 768) table.parentElement.style.display = 'block';
  
  emptyState.style.display = 'none';
  
  // 添加数据行
  for (const [keyword, config] of Object.entries(currentConfig.modelConfigs)) {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td><strong>\${keyword}</strong></td>
      <td>
        <span class="text-secondary" title="\${config.endpoint || ''}">\${maskEndpoint(config.endpoint || '')}</span>
      </td>
      <td><span class="monospace">\${maskApiKey(config.apiKey || '')}</span></td>
      <td class="actions">
        <button class="btn btn-outline btn-sm test-btn" data-keyword="\${keyword}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          测试
        </button>
        <button class="btn btn-outline btn-sm edit-btn" data-type="model-configs" data-key="\${keyword}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn btn-danger btn-sm delete-btn" data-type="model-configs" data-key="\${keyword}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </td>
    \`;
    table.appendChild(row);
  }
  
  // 添加测试按钮事件
  document.querySelectorAll('.test-btn').forEach(button => {
    button.addEventListener('click', function() {
      const keyword = this.getAttribute('data-keyword');
      openTestModal(keyword);
    });
  });
  
  // 添加编辑和删除按钮事件
  document.querySelectorAll('#modelConfigsTable .edit-btn').forEach(button => {
    button.addEventListener('click', function() {
      const type = this.getAttribute('data-type');
      const key = this.getAttribute('data-key');
      const config = currentConfig.modelConfigs[key];
      openModal(type, { key, config: config });
    });
  });
  
  document.querySelectorAll('#modelConfigsTable .delete-btn').forEach(button => {
    button.addEventListener('click', function() {
      const type = this.getAttribute('data-type');
      const key = this.getAttribute('data-key');
      confirmDelete(type, key);
    });
  });
}

// 更新认证密钥表格
function updateAuthKeysTable() {
  const table = document.getElementById('authKeysTable');
  if(!table) return;
  
  const emptyState = document.getElementById('authKeysEmpty');
  
  // 清空表格
  table.innerHTML = '';
  
  // 检查是否有数据
  if (currentConfig.authKeys.length === 0) {
    table.parentElement.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  
  table.parentElement.style.display = 'table'; // Fix display
  if(window.innerWidth <= 768) table.parentElement.style.display = 'block';
  
  emptyState.style.display = 'none';
  
  // 添加数据行
  currentConfig.authKeys.forEach((authKey, index) => {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td><span class="monospace">\${maskApiKey(authKey)}</span></td>
      <td class="actions">
        <button class="btn btn-outline btn-sm edit-btn" data-type="auth-keys" data-index="\${index}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          编辑
        </button>
        <button class="btn btn-danger btn-sm delete-btn" data-type="auth-keys" data-index="\${index}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          删除
        </button>
      </td>
    \`;
    table.appendChild(row);
  });
  
  // 添加编辑和删除按钮事件
  document.querySelectorAll('#authKeysTable .edit-btn').forEach(button => {
    button.addEventListener('click', function() {
      const type = this.getAttribute('data-type');
      const index = parseInt(this.getAttribute('data-index'));
      openModal(type, { index, value: currentConfig.authKeys[index] });
    });
  });
  
  document.querySelectorAll('#authKeysTable .delete-btn').forEach(button => {
    button.addEventListener('click', function() {
      const type = this.getAttribute('data-type');
      const index = parseInt(this.getAttribute('data-index'));
      confirmDelete(type, index);
    });
  });
}

// 打开模态框
function openModal(type, data) {
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modalTitle');
  const modalForm = document.getElementById('modalForm');
  
  // 根据类型生成表单
  let formHTML = '';
  let title = '';
  
  switch (type) {
    case 'model-configs':
      title = data ? '编辑模型配置' : '添加模型配置';
      formHTML = \`
        <div class="form-group">
          <label for="modelKeyword">模型关键词</label>
          <input type="text" id="modelKeyword" name="keyword" placeholder="例如: gpt-4" required value="\${data ? data.key : ''}">
          <small>模型关键词用于匹配请求中的model参数</small>
        </div>
        <div class="form-group">
          <label for="modelEndpoint">API端点</label>
          <input type="text" id="modelEndpoint" name="endpoint" placeholder="例如: https://api.openai.com/v1" required value="\${data ? data.config.endpoint : ''}">
          <small>完整的API端点URL，包含路径</small>
        </div>
        <div class="form-group">
          <label for="modelApiKey">API密钥</label>
          <input type="text" id="modelApiKey" name="apiKey" placeholder="输入API密钥" required value="\${data ? data.config.apiKey : ''}">
          <small>用于访问目标API的密钥</small>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline cancel-btn">取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      \`;
      break;
      
    case 'auth-keys':
      title = data ? '编辑认证密钥' : '添加认证密钥';
      formHTML = \`
        <div class="form-group">
          <label for="authKeyValue">认证密钥</label>
          <input type="text" id="authKeyValue" name="authKey" placeholder="输入认证密钥" required value="\${data ? data.value : ''}">
          <small>用于验证API路由请求的密钥</small>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline cancel-btn">取消</button>
          <button type="submit" class="btn btn-primary">保存</button>
        </div>
      \`;
      break;
  }
  
  modalTitle.textContent = title;
  modalForm.innerHTML = formHTML;
  modalForm.dataset.type = type;
  modalForm.dataset.editKey = data ? (data.key !== undefined ? data.key : data.index) : '';
  
  // 添加表单提交事件
  modalForm.onsubmit = function(e) {
    e.preventDefault();
    saveModalItem(type, data);
  };
  
  // 重新绑定取消按钮事件
  modalForm.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      modal.style.display = 'none';
    });
  });
  
  modal.style.display = 'block';
}

// 打开测试模态框
function openTestModal(keyword) {
  const modal = document.getElementById('testModal');
  const testModel = document.getElementById('testModel');
  const testResult = document.getElementById('testResult');
  
  // 填充模型选项
  testModel.innerHTML = '';
  for (const key of Object.keys(currentConfig.modelConfigs)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    if (key === keyword) {
      option.selected = true;
    }
    testModel.appendChild(option);
  }
  
  // 清空测试结果
  testResult.innerHTML = '';
  testResult.className = 'test-result';
  testResult.style.display = 'none'; // 先隐藏
  
  modal.style.display = 'block';
}

// 测试模型
async function testModel(e) {
  e.preventDefault();
  
  const testModel = document.getElementById('testModel').value;
  const testMessage = document.getElementById('testMessage').value;
  const testResult = document.getElementById('testResult');
  
  // 显示测试中状态
  testResult.style.display = 'block';
  testResult.innerHTML = '<div class="spinner-sm"></div> &nbsp;正在连接API...';
  testResult.className = 'test-result';
  
  try {
    const response = await fetch('/api/test-model', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        modelKeyword: testModel,
        testMessage: testMessage
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      testResult.innerHTML = \`
        <h3>✅ 测试成功</h3>
        <p><strong>模型:</strong> \${testModel}</p>
        <p><strong>响应:</strong> \${data.response}</p>
      \`;
      testResult.className = 'test-result success';
    } else {
      testResult.innerHTML = \`
        <h3>❌ 测试失败</h3>
        <p><strong>模型:</strong> \${testModel}</p>
        <p><strong>错误:</strong> \${data.error}</p>
      \`;
      testResult.className = 'test-result error';
    }
  } catch (error) {
    testResult.innerHTML = \`
      <h3>❌ 测试失败</h3>
      <p><strong>模型:</strong> \${testModel}</p>
      <p><strong>错误:</strong> \${error.message}</p>
    \`;
    testResult.className = 'test-result error';
  }
}

// 保存模态框中的项目
function saveModalItem(type, data) {
  const modalForm = document.getElementById('modalForm');
  const formData = new FormData(modalForm);
  
  switch (type) {
    case 'model-configs':
      const keyword = formData.get('keyword');
      const endpoint = formData.get('endpoint');
      const apiKey = formData.get('apiKey');
      
      if (data) {
        // 编辑现有项
        delete currentConfig.modelConfigs[data.key];
      }
      
      currentConfig.modelConfigs[keyword] = {
        endpoint: endpoint,
        apiKey: apiKey
      };
      updateModelConfigsTable();
      break;
      
    case 'auth-keys':
      const authKey = formData.get('authKey');
      
      if (data !== null) {
        // 编辑现有项
        currentConfig.authKeys[data.index] = authKey;
      } else {
        // 添加新项
        currentConfig.authKeys.push(authKey);
      }
      
      updateAuthKeysTable();
      break;
  }
  
  document.getElementById('modal').style.display = 'none';
  showNotification('项目已添加到暂存区，请点击“保存”以持久化', 'success');
}

// 确认删除
function confirmDelete(type, key) {
  const itemType = type === 'model-configs' ? '模型配置' : '认证密钥';
  
  if (confirm(\`确定要删除此\${itemType}吗？\`)) {
    deleteItem(type, key);
  }
}

// 删除项目
function deleteItem(type, key) {
  switch (type) {
    case 'model-configs':
      delete currentConfig.modelConfigs[key];
      updateModelConfigsTable();
      break;
      
    case 'auth-keys':
      currentConfig.authKeys.splice(key, 1);
      updateAuthKeysTable();
      break;
  }
  
  showNotification('项目已删除，请点击“保存”以持久化', 'warning');
}

// 保存配置到服务器
async function saveConfig() {
  try {
    showLoading();
    
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(currentConfig)
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to save configuration');
    }
    
    hideLoading();
    showNotification(data.message || '配置已成功保存', 'success');
  } catch (error) {
    hideLoading();
    console.error('Error saving config:', error);
    showNotification('保存配置失败: ' + error.message, 'error');
  }
}

// 导出配置
function exportConfig() {
  const dataStr = JSON.stringify(currentConfig, null, 2);
  const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
  
  const exportFileDefaultName = 'api-router-config-' + new Date().toISOString().slice(0,10) + '.json';
  
  const linkElement = document.createElement('a');
  linkElement.setAttribute('href', dataUri);
  linkElement.setAttribute('download', exportFileDefaultName);
  linkElement.click();
  
  showNotification('配置已导出', 'success');
}

// 导入配置
function importConfig(e) {
  const file = e.target.files[0];
  
  if (!file) return;
  
  const reader = new FileReader();
  
  reader.onload = function(event) {
    try {
      const importedConfig = JSON.parse(event.target.result);
      
      if (!importedConfig.modelConfigs || !importedConfig.authKeys) {
        throw new Error('无效的配置文件格式');
      }
      
      currentConfig = importedConfig;
      updateModelConfigsTable();
      updateAuthKeysTable();
      
      showNotification('配置已导入，请点击“保存”以持久化', 'success');
    } catch (error) {
      showNotification('导入配置失败: ' + error.message, 'error');
    }
  };
  
  reader.readAsText(file);
  
  // 重置文件输入
  e.target.value = '';
}

// 退出登录
async function logout() {
  if (confirm('确定要退出登录吗？')) {
    try {
      await fetch('/api/logout');
      window.location.href = '/';
    } catch (error) {
      showNotification('退出登录失败: ' + error.message, 'error');
    }
  }
}

// 显示加载状态
function showLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if(overlay) overlay.style.display = 'flex';
}

// 隐藏加载状态
function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if(overlay) overlay.style.display = 'none';
}

// 显示通知
function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  if(!notification) return;
  
  notification.textContent = message;
  notification.className = 'notification ' + type;
  notification.classList.add('show');
  
  setTimeout(() => {
    notification.classList.remove('show');
  }, 3000);
}

// 遮蔽API密钥
function maskApiKey(apiKey) {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return apiKey;
  return apiKey.substring(0, 4) + '•••' + apiKey.substring(apiKey.length - 4);
}

// 遮蔽API端点
function maskEndpoint(endpoint) {
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    const protocol = url.protocol;
    const hostname = url.hostname;
    const port = url.port;
    const pathname = url.pathname;
    
    // 遮蔽主机名中间部分
    let maskedHostname = hostname;
    if (hostname.length > 8) {
      maskedHostname = hostname.substring(0, 4) + '•••' + hostname.substring(hostname.length - 4);
    }
    
    // 确保端口是数字
    const portStr = (port && port !== '80' && port !== '443') ? ':' + port : '';
    
    // 检查路径是否过长
    let maskedPathname = pathname;
    if (pathname.length > 15) {
      maskedPathname = pathname.substring(0, 8) + '•••' + pathname.substring(pathname.length - 7);
    }
    
    return protocol + '//' + maskedHostname + portStr + maskedPathname;
  } catch (error) {
    // 如果URL解析失败，简单遮蔽中间部分
    if (endpoint.length > 20) {
      return endpoint.substring(0, 10) + '•••' + endpoint.substring(endpoint.length - 10);
    }
    return endpoint;
  }
}`;
}

// 原有的辅助函数
async function forwardRequest(targetEndpoint, apiPath, headers, requestBody) {
  try {
    if (targetEndpoint.includes("cloudflare.com")) {
      const targetUrl2 = `${targetEndpoint}${apiPath.replace(/^\/v1/, "")}`;
      console.log(`Forwarding to Cloudflare API: ${targetUrl2}`);
      const newRequest2 = new Request(targetUrl2, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody)
      });
      const response2 = await fetch(newRequest2);
      return createCorsResponse(response2);
    }
    
    const cleanEndpoint = targetEndpoint.replace(/\/$/, "");
    const cleanPath = apiPath.replace(/^\//, "");
    const targetUrl = `${cleanEndpoint}/${cleanPath}`;
    console.log(`Forwarding to: ${targetUrl}`);
    
    const newRequest = new Request(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    
    const response = await fetch(newRequest);
    return createCorsResponse(response);
  } catch (error) {
    console.error(`Error forwarding request to ${targetEndpoint}:`, error);
    throw error;
  }
}

function isValidApiKey(apiKey) {
  if (!apiKey || !parsedAuthKeys) {
    return false;
  }
  return parsedAuthKeys.includes(apiKey);
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    }
  });
}

function createCorsResponse(response) {
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
  
  newResponse.headers.set("Access-Control-Allow-Origin", "*");
  newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newResponse.headers.set("Access-Control-Allow-Headers", "*");
  
  return newResponse;
}

function determineTargetApi(requestBody) {
  const modelName = requestBody.model || "";
  console.log(`Processing request for model: ${modelName}`);
  
  if (!parsedModelConfigs) {
    throw new Error("配置未正确初始化");
  }
  
  console.log("Available model configs:", Object.keys(parsedModelConfigs).join(", "));
  
  let targetConfig = null;
  let matchedKeyword = null;
  
  for (const [keyword, config] of Object.entries(parsedModelConfigs)) {
    if (modelName.includes(keyword)) {
      targetConfig = config;
      matchedKeyword = keyword;
      console.log(`Matched keyword "${keyword}" for model "${modelName}"`);
      break;
    }
  }
  
  if (!targetConfig) {
    // 如果没有匹配到，使用第一个配置作为默认
    const firstKeyword = Object.keys(parsedModelConfigs)[0];
    targetConfig = parsedModelConfigs[firstKeyword];
    matchedKeyword = firstKeyword;
    console.log(`No match found for model "${modelName}", using default config: ${firstKeyword}`);
  }
  
  console.log(`Selected API endpoint: ${targetConfig.endpoint}`);
  console.log(`Using API key for: ${matchedKeyword}`);
  
  return {
    targetEndpoint: targetConfig.endpoint,
    targetApiKey: targetConfig.apiKey
  };
}