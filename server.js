/**
 * 人生的账本 - 后端服务器
 * Express + PostgreSQL
 */
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 数据库连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 默认类目
const DEFAULT_EXPENSE = [
  { name: '餐饮', icon: '🍜' }, { name: '交通', icon: '🚕' }, { name: '购物', icon: '🛒' },
  { name: '娱乐', icon: '🎮' }, { name: '居住', icon: '🏠' }, { name: '医疗', icon: '💊' },
  { name: '教育', icon: '📚' }, { name: '日用', icon: '🧻' }, { name: '通讯', icon: '📱' },
  { name: '其他', icon: '💸' }
];
const DEFAULT_INCOME = [
  { name: '工资', icon: '💼' }, { name: '奖金', icon: '🎁' }, { name: '兼职', icon: '💻' },
  { name: '理财', icon: '📈' }, { name: '红包', icon: '🧧' }, { name: '其他', icon: '💰' }
];
const AVATARS = ['🐰','🐱','🐶','🐻','🦊','🐼','🐨','🐯','🦁','🐸','🦄','🐷'];
const ROLE_WEIGHT = { owner: 3, admin: 2, editor: 1, viewer: 0 };

// 初始化数据库（支持懒加载，首次请求时建表，适用于本地和 Netlify Functions）
let dbInited = false;
let dbInitPromise = null;
async function initDB() {
  if (dbInited) return;
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          theme TEXT DEFAULT 'pink',
          avatar TEXT DEFAULT '🐱',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ledgers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          owner_id INT REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS members (
          ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          role TEXT DEFAULT 'editor',
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (ledger_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          icon TEXT DEFAULT '📌',
          sort INT DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY,
          ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          date TEXT NOT NULL,
          category_id TEXT,
          note TEXT DEFAULT '',
          member_username TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS invites (
          token TEXT PRIMARY KEY,
          ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
          role TEXT DEFAULT 'viewer',
          created_by INT REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      dbInited = true;
      console.log('数据库初始化完成');
    } finally {
      client.release();
    }
  })();
  return dbInitPromise;
}

// 确保数据库已初始化的中间件（所有 API 请求前先过这里，保证表存在）
async function ensureDB(req, res, next) {
  try {
    await initDB();
    next();
  } catch (e) {
    console.error('数据库初始化失败:', e);
    res.status(500).json({ ok: false, msg: '数据库初始化失败: ' + e.message });
  }
}
app.use((req, res, next) => {
  // 只对 /api/* 请求启用初始化中间件，静态资源请求跳过
  if (req.path.startsWith('/api/')) return ensureDB(req, res, next);
  next();
});

// 生成唯一ID
function genId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// 认证中间件
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const result = await pool.query('SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1', [token]);
    if (result.rows.length === 0) return res.status(401).json({ error: '登录已过期' });
    req.user = result.rows[0];
    req.token = token;
    next();
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
}

// 获取用户在账本中的角色
async function getRole(ledgerId, userId) {
  const result = await pool.query('SELECT role FROM members WHERE ledger_id = $1 AND user_id = $2', [ledgerId, userId]);
  return result.rows.length > 0 ? result.rows[0].role : null;
}

// 检查权限
async function checkPerm(ledgerId, userId, minRole) {
  const role = await getRole(ledgerId, userId);
  return role !== null && (ROLE_WEIGHT[role] || 0) >= (ROLE_WEIGHT[minRole] || 0);
}

// 获取账本的类目数据
async function getCategories(ledgerId) {
  const result = await pool.query('SELECT * FROM categories WHERE ledger_id = $1 ORDER BY sort, name', [ledgerId]);
  const expense = result.rows.filter(c => c.type === 'expense');
  const income = result.rows.filter(c => c.type === 'income');
  return { expense, income };
}

// 获取账本完整数据（含类目和成员）
async function getLedgerFull(ledgerId) {
  const ledgerResult = await pool.query('SELECT l.*, u.username as owner_username FROM ledgers l JOIN users u ON l.owner_id = u.id WHERE l.id = $1', [ledgerId]);
  if (ledgerResult.rows.length === 0) return null;
  const ledger = ledgerResult.rows[0];
  const categories = await getCategories(ledgerId);
  const membersResult = await pool.query('SELECT m.*, u.username, u.avatar, u.theme FROM members m JOIN users u ON m.user_id = u.id WHERE m.ledger_id = $1', [ledgerId]);
  return {
    id: ledger.id,
    name: ledger.name,
    desc: ledger.description,
    owner: ledger.owner_username,
    owner_id: ledger.owner_id,
    categories,
    members: membersResult.rows.map(m => ({ username: m.username, role: m.role, joinedAt: new Date(m.joined_at).getTime(), avatar: m.avatar, theme: m.theme })),
    createdAt: new Date(ledger.created_at).getTime()
  };
}

// ========== API 路由 ==========

// 注册
app.post('/api/register', async (req, res) => {
  const { username, password, theme } = req.body;
  if (!username || username.length < 2) return res.json({ ok: false, msg: '用户名至少2位' });
  if (!password || password.length < 6) return res.json({ ok: false, msg: '密码至少6位' });
  try {
    // 重名检测
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0) return res.json({ ok: false, msg: '用户名已存在' });

    const hash = await bcrypt.hash(password, 10);
    const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
    const userResult = await pool.query(
      'INSERT INTO users (username, password, theme, avatar) VALUES ($1, $2, $3, $4) RETURNING id, username, theme, avatar',
      [username, hash, theme || 'pink', avatar]
    );
    const user = userResult.rows[0];

    // 创建默认账本
    const lid = genId('led_');
    await pool.query('INSERT INTO ledgers (id, name, description, owner_id) VALUES ($1, $2, $3, $4)', [lid, '我的账本', '生活日常开销', user.id]);
    await pool.query('INSERT INTO members (ledger_id, user_id, role) VALUES ($1, $2, $3)', [lid, user.id, 'owner']);
    // 创建默认类目
    for (let i = 0; i < DEFAULT_EXPENSE.length; i++) {
      const c = DEFAULT_EXPENSE[i];
      await pool.query('INSERT INTO categories (id, ledger_id, type, name, icon, sort) VALUES ($1, $2, $3, $4, $5, $6)', [genId('cat_'), lid, 'expense', c.name, c.icon, i]);
    }
    for (let i = 0; i < DEFAULT_INCOME.length; i++) {
      const c = DEFAULT_INCOME[i];
      await pool.query('INSERT INTO categories (id, ledger_id, type, name, icon, sort) VALUES ($1, $2, $3, $4, $5, $6)', [genId('cat_'), lid, 'income', c.name, c.icon, i]);
    }

    // 创建会话
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);

    res.json({ ok: true, user: { username: user.username, theme: user.theme, avatar: user.avatar }, token, defaultLedgerId: lid });
  } catch (e) {
    console.error('注册错误:', e);
    res.json({ ok: false, msg: '注册失败: ' + e.message });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, msg: '请输入用户名和密码' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.json({ ok: false, msg: '用户不存在' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ ok: false, msg: '密码错误' });

    const token = crypto.randomBytes(24).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);

    res.json({ ok: true, user: { username: user.username, theme: user.theme, avatar: user.avatar }, token });
  } catch (e) {
    res.json({ ok: false, msg: '登录失败: ' + e.message });
  }
});

// 获取当前用户信息
app.get('/api/user', auth, async (req, res) => {
  res.json({ ok: true, user: { username: req.user.username, theme: req.user.theme, avatar: req.user.avatar } });
});

// 退出登录
app.post('/api/logout', auth, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
});

// 更新主题
app.patch('/api/user/theme', auth, async (req, res) => {
  const { theme } = req.body;
  const valid = ['pink', 'blue', 'green', 'orange', 'purple', 'peach'];
  if (!valid.includes(theme)) return res.json({ ok: false, msg: '无效主题' });
  await pool.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.user.id]);
  res.json({ ok: true });
});

// 检查用户名是否存在
app.get('/api/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ exists: false });
  const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  res.json({ exists: result.rows.length > 0 });
});

// 获取用户所有账本
app.get('/api/ledgers', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, u.username as owner_username,
        (SELECT COUNT(*) FROM records r WHERE r.ledger_id = l.id) as record_count,
        (SELECT role FROM members WHERE ledger_id = l.id AND user_id = $2) as my_role
      FROM ledgers l
      JOIN members m ON m.ledger_id = l.id AND m.user_id = $2
      JOIN users u ON l.owner_id = u.id
      ORDER BY l.created_at DESC
    `, [req.user.id, req.user.id]);

    const ledgers = [];
    for (const row of result.rows) {
      const full = await getLedgerFull(row.id);
      const recordsResult = await pool.query('SELECT COALESCE(SUM(CASE WHEN type = $1 THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type = $2 THEN amount ELSE 0 END), 0) as expense FROM records WHERE ledger_id = $3', ['income', 'expense', row.id]);
      ledgers.push({
        ...full,
        myRole: row.my_role,
        recordCount: parseInt(row.record_count),
        totalIncome: parseFloat(recordsResult.rows[0].income),
        totalExpense: parseFloat(recordsResult.rows[0].expense)
      });
    }
    res.json({ ok: true, ledgers });
  } catch (e) {
    res.json({ ok: false, msg: '获取账本失败: ' + e.message });
  }
});

// 获取单个账本详情
app.get('/api/ledgers/:id', auth, async (req, res) => {
  try {
    const role = await getRole(req.params.id, req.user.id);
    if (role === null) return res.json({ ok: false, msg: '无权访问此账本' });
    const ledger = await getLedgerFull(req.params.id);
    if (!ledger) return res.json({ ok: false, msg: '账本不存在' });
    // 获取记录
    const recordsResult = await pool.query('SELECT * FROM records WHERE ledger_id = $1 ORDER BY date DESC, created_at DESC', [req.params.id]);
    ledger.records = recordsResult.rows.map(r => ({
      id: r.id,
      type: r.type,
      amount: String(r.amount),
      date: r.date,
      catId: r.category_id,
      note: r.note,
      member: r.member_username,
      createdAt: new Date(r.created_at).getTime()
    }));
    res.json({ ok: true, ledger, myRole: role });
  } catch (e) {
    res.json({ ok: false, msg: '获取账本失败: ' + e.message });
  }
});

// 创建账本
app.post('/api/ledgers', auth, async (req, res) => {
  const { name, desc } = req.body;
  if (!name) return res.json({ ok: false, msg: '请输入账本名称' });
  try {
    const lid = genId('led_');
    await pool.query('INSERT INTO ledgers (id, name, description, owner_id) VALUES ($1, $2, $3, $4)', [lid, name, desc || '', req.user.id]);
    await pool.query('INSERT INTO members (ledger_id, user_id, role) VALUES ($1, $2, $3)', [lid, req.user.id, 'owner']);
    for (let i = 0; i < DEFAULT_EXPENSE.length; i++) {
      const c = DEFAULT_EXPENSE[i];
      await pool.query('INSERT INTO categories (id, ledger_id, type, name, icon, sort) VALUES ($1, $2, $3, $4, $5, $6)', [genId('cat_'), lid, 'expense', c.name, c.icon, i]);
    }
    for (let i = 0; i < DEFAULT_INCOME.length; i++) {
      const c = DEFAULT_INCOME[i];
      await pool.query('INSERT INTO categories (id, ledger_id, type, name, icon, sort) VALUES ($1, $2, $3, $4, $5, $6)', [genId('cat_'), lid, 'income', c.name, c.icon, i]);
    }
    res.json({ ok: true, ledgerId: lid });
  } catch (e) {
    res.json({ ok: false, msg: '创建失败: ' + e.message });
  }
});

// 添加记录
app.post('/api/ledgers/:id/records', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'editor')) return res.json({ ok: false, msg: '暂无编辑权限' });
    const { type, amount, date, catId, note, member } = req.body;
    if (!type || !amount || !date) return res.json({ ok: false, msg: '参数不完整' });
    const rid = genId('rec_');
    await pool.query(
      'INSERT INTO records (id, ledger_id, type, amount, date, category_id, note, member_username) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [rid, req.params.id, type, parseFloat(amount), date, catId, note || '', member || req.user.username]
    );
    res.json({ ok: true, recordId: rid });
  } catch (e) {
    res.json({ ok: false, msg: '添加失败: ' + e.message });
  }
});

// 批量添加记录（CSV导入）
app.post('/api/ledgers/:id/records/batch', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'editor')) return res.json({ ok: false, msg: '暂无编辑权限' });
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) return res.json({ ok: false, msg: '无数据' });
    let count = 0;
    for (const r of records) {
      const rid = genId('rec_');
      await pool.query(
        'INSERT INTO records (id, ledger_id, type, amount, date, category_id, note, member_username) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [rid, req.params.id, r.type, parseFloat(r.amount), r.date, r.catId, r.note || '', r.member || req.user.username]
      );
      count++;
    }
    res.json({ ok: true, count });
  } catch (e) {
    res.json({ ok: false, msg: '导入失败: ' + e.message });
  }
});

// 删除记录
app.delete('/api/ledgers/:id/records/:rid', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM records WHERE id = $1 AND ledger_id = $2', [req.params.rid, req.params.id]);
    if (result.rows.length === 0) return res.json({ ok: false, msg: '记录不存在' });
    const record = result.rows[0];
    const role = await getRole(req.params.id, req.user.id);
    if (!role) return res.json({ ok: false, msg: '无权操作' });
    // 管理员可删除任何记录，普通用户只能删自己的
    if (ROLE_WEIGHT[role] < 2 && record.member_username !== req.user.username) {
      return res.json({ ok: false, msg: '无权删除他人记录' });
    }
    await pool.query('DELETE FROM records WHERE id = $1', [req.params.rid]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: '删除失败: ' + e.message });
  }
});

// 添加类目
app.post('/api/ledgers/:id/categories', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'admin')) return res.json({ ok: false, msg: '只有管理员可以管理类目' });
    const { type, name, icon } = req.body;
    if (!type || !name) return res.json({ ok: false, msg: '参数不完整' });
    const exists = await pool.query('SELECT id FROM categories WHERE ledger_id = $1 AND type = $2 AND name = $3', [req.params.id, type, name]);
    if (exists.rows.length > 0) return res.json({ ok: false, msg: '类目已存在' });
    const cid = genId('cat_');
    const maxSort = await pool.query('SELECT COALESCE(MAX(sort), 0) + 1 as s FROM categories WHERE ledger_id = $1 AND type = $2', [req.params.id, type]);
    await pool.query('INSERT INTO categories (id, ledger_id, type, name, icon, sort) VALUES ($1, $2, $3, $4, $5, $6)', [cid, req.params.id, type, name, icon || '📌', maxSort.rows[0].s]);
    res.json({ ok: true, categoryId: cid });
  } catch (e) {
    res.json({ ok: false, msg: '添加失败: ' + e.message });
  }
});

// 删除类目
app.delete('/api/ledgers/:id/categories/:cid', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'admin')) return res.json({ ok: false, msg: '只有管理员可以管理类目' });
    // 将使用该类目的记录的 category_id 设为 NULL
    await pool.query('UPDATE records SET category_id = NULL WHERE ledger_id = $1 AND category_id = $2', [req.params.id, req.params.cid]);
    await pool.query('DELETE FROM categories WHERE id = $1 AND ledger_id = $2', [req.params.cid, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: '删除失败: ' + e.message });
  }
});

// 通过用户名邀请
app.post('/api/ledgers/:id/invite', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'admin')) return res.json({ ok: false, msg: '只有管理员可以邀请成员' });
    const { username, role } = req.body;
    if (!username) return res.json({ ok: false, msg: '请输入用户名' });
    const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) return res.json({ ok: false, msg: '用户不存在，请先让对方注册' });
    const targetUserId = userResult.rows[0].id;
    const existing = await getRole(req.params.id, targetUserId);
    if (existing !== null) return res.json({ ok: false, msg: '该成员已在账本中' });
    const validRoles = ['admin', 'editor', 'viewer'];
    const finalRole = validRoles.includes(role) ? role : 'viewer';
    await pool.query('INSERT INTO members (ledger_id, user_id, role) VALUES ($1, $2, $3)', [req.params.id, targetUserId, finalRole]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: '邀请失败: ' + e.message });
  }
});

// 生成邀请链接
app.post('/api/ledgers/:id/invite-link', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'admin')) return res.json({ ok: false, msg: '只有管理员可以邀请成员' });
    const { role } = req.body;
    const validRoles = ['admin', 'editor', 'viewer'];
    const finalRole = validRoles.includes(role) ? role : 'viewer';
    const token = crypto.randomBytes(16).toString('hex');
    await pool.query('INSERT INTO invites (token, ledger_id, role, created_by) VALUES ($1, $2, $3, $4)', [token, req.params.id, finalRole, req.user.id]);
    res.json({ ok: true, token });
  } catch (e) {
    res.json({ ok: false, msg: '生成链接失败: ' + e.message });
  }
});

// 通过邀请链接加入
app.post('/api/invites/:token/join', auth, async (req, res) => {
  try {
    const inviteResult = await pool.query('SELECT * FROM invites WHERE token = $1', [req.params.token]);
    if (inviteResult.rows.length === 0) return res.json({ ok: false, msg: '邀请链接无效或已过期' });
    const invite = inviteResult.rows[0];
    const existing = await getRole(invite.ledger_id, req.user.id);
    if (existing !== null) return res.json({ ok: true, ledgerId: invite.ledger_id, msg: '您已在该账本中' });
    await pool.query('INSERT INTO members (ledger_id, user_id, role) VALUES ($1, $2, $3)', [invite.ledger_id, req.user.id, invite.role]);
    // 删除已使用的邀请
    await pool.query('DELETE FROM invites WHERE token = $1', [req.params.token]);
    res.json({ ok: true, ledgerId: invite.ledger_id });
  } catch (e) {
    res.json({ ok: false, msg: '加入失败: ' + e.message });
  }
});

// 获取邀请链接对应的账本信息（未登录时查看）
app.get('/api/invites/:token', async (req, res) => {
  try {
    const inviteResult = await pool.query('SELECT i.*, l.name, l.description, u.username as owner_username FROM invites i JOIN ledgers l ON i.ledger_id = l.id JOIN users u ON l.owner_id = u.id WHERE i.token = $1', [req.params.token]);
    if (inviteResult.rows.length === 0) return res.json({ ok: false, msg: '邀请链接无效或已过期' });
    const invite = inviteResult.rows[0];
    res.json({ ok: true, ledger: { id: invite.ledger_id, name: invite.name, desc: invite.description, owner: invite.owner_username, role: invite.role } });
  } catch (e) {
    res.json({ ok: false, msg: '获取信息失败' });
  }
});

// 移除成员
app.delete('/api/ledgers/:id/members/:username', auth, async (req, res) => {
  try {
    if (!await checkPerm(req.params.id, req.user.id, 'admin')) return res.json({ ok: false, msg: '只有管理员可以移除成员' });
    const targetResult = await pool.query('SELECT u.id, m.role FROM users u JOIN members m ON m.user_id = u.id WHERE u.username = $1 AND m.ledger_id = $2', [req.params.username, req.params.id]);
    if (targetResult.rows.length === 0) return res.json({ ok: false, msg: '成员不存在' });
    if (targetResult.rows[0].role === 'owner') return res.json({ ok: false, msg: '拥有者不能被移除' });
    await pool.query('DELETE FROM members WHERE ledger_id = $1 AND user_id = $2', [req.params.id, targetResult.rows[0].id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: '移除失败: ' + e.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 启动
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));
}).catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
