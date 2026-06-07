// ================================================
// Ak-Kalpak — Полный бэкенд сервер
// ================================================
// npm install → node server.js
// ================================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { Server } = require('socket.io');
const http       = require('http');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const PORT         = process.env.PORT || 3000;
const JWT_SECRET   = process.env.JWT_SECRET || 'ak-kalpak-secret-key-change-me';
const TG_TOKEN     = process.env.TELEGRAM_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const CAFE_ID      = 1;

const app      = express();
const server   = http.createServer(app);
const io       = new Server(server, { cors: { origin: '*' } });
const pool     = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---- УТИЛИТЫ ----

async function sendTelegram(chatIds, text) {
  if (!TG_TOKEN || !chatIds.length) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  for (const chatId of chatIds) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
    } catch (e) { console.error('TG error:', e.message); }
  }
}

async function getWaiterChatIds() {
  const { rows } = await pool.query(
    `SELECT telegram_chat_id FROM staff WHERE cafe_id=$1 AND is_active=TRUE AND telegram_chat_id IS NOT NULL`,
    [CAFE_ID]
  );
  return rows.map(r => r.telegram_chat_id);
}

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Токен недействителен' }); }
}

function managerOnly(req, res, next) {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Нет доступа' });
  next();
}

// ---- AUTH ----

app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM staff WHERE login=$1 AND is_active=TRUE AND cafe_id=$2',
      [login, CAFE_ID]
    );
    if (!rows.length) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role, cafe_id: user.cafe_id }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- МЕНЮ (публичное) ----

app.get('/api/menu', async (req, res) => {
  try {
    const cats   = await pool.query('SELECT * FROM categories WHERE cafe_id=$1 ORDER BY sort_order', [CAFE_ID]);
    const dishes = await pool.query(
      `SELECT d.*, c.name as category_name FROM dishes d
       LEFT JOIN categories c ON d.category_id=c.id
       WHERE d.cafe_id=$1 AND d.is_hidden=FALSE ORDER BY d.sort_order`,
      [CAFE_ID]
    );
    res.json({ categories: cats.rows, dishes: dishes.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- МЕНЮ (менеджер) ----

app.get('/api/manager/menu', auth, managerOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, c.name as category_name FROM dishes d
       LEFT JOIN categories c ON d.category_id=c.id
       WHERE d.cafe_id=$1 ORDER BY c.sort_order, d.sort_order`,
      [CAFE_ID]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/manager/dishes', auth, managerOnly, async (req, res) => {
  const { name, description, price, category_id, photo_base64 } = req.body;
  try {
    let photo_url = null;
    if (photo_base64) {
      const buf = Buffer.from(photo_base64.split(',')[1], 'base64');
      const fname = `dishes/${Date.now()}.jpg`;
      await supabase.storage.from('photos').upload(fname, buf, { contentType: 'image/jpeg', upsert: true });
      const { data } = supabase.storage.from('photos').getPublicUrl(fname);
      photo_url = data.publicUrl;
    }
    const { rows } = await pool.query(
      `INSERT INTO dishes (cafe_id, category_id, name, description, price, photo_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [CAFE_ID, category_id, name, description, price, photo_url]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/manager/dishes/:id', auth, managerOnly, async (req, res) => {
  const { name, description, price, category_id, photo_base64, is_hidden } = req.body;
  try {
    let photo_url = req.body.photo_url;
    if (photo_base64?.startsWith('data:')) {
      const buf = Buffer.from(photo_base64.split(',')[1], 'base64');
      const fname = `dishes/${req.params.id}_${Date.now()}.jpg`;
      await supabase.storage.from('photos').upload(fname, buf, { contentType: 'image/jpeg', upsert: true });
      const { data } = supabase.storage.from('photos').getPublicUrl(fname);
      photo_url = data.publicUrl;
    }
    const { rows } = await pool.query(
      `UPDATE dishes SET name=$1, description=$2, price=$3, category_id=$4, photo_url=$5, is_hidden=$6 WHERE id=$7 AND cafe_id=$8 RETURNING *`,
      [name, description, price, category_id, photo_url, is_hidden, req.params.id, CAFE_ID]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ЗАКАЗЫ ----

app.get('/api/orders', auth, async (req, res) => {
  const bishkekNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const date = req.query.date || bishkekNow.toISOString().split('T')[0];
  // Конвертируем бишкекскую дату в UTC диапазон
  // Бишкек UTC+6: начало дня 00:00 BSK = 18:00 предыдущего дня UTC
  const startUTC = new Date(date + 'T00:00:00+06:00');
  const endUTC = new Date(date + 'T23:59:59+06:00');
  try {
    const { rows: orders } = await pool.query(
      `SELECT o.* FROM orders o
       WHERE o.cafe_id=$1 AND o.created_at >= $2 AND o.created_at <= $3
       ORDER BY o.created_at DESC`,
      [CAFE_ID, startUTC.toISOString(), endUTC.toISOString()]
    );
    for (const order of orders) {
      const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [order.id]);
      order.items = items;
    }
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', auth, async (req, res) => {
  const { table_name, items } = req.body;
  if (!table_name || !items?.length) return res.status(400).json({ error: 'Нет данных' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const { rows } = await client.query(
      `INSERT INTO orders (cafe_id, table_name, waiter_id, waiter_name, total) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [CAFE_ID, table_name, req.user.id, req.user.name, total]
    );
    const order = rows[0];
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, dish_id, dish_name, dish_price, quantity) VALUES ($1,$2,$3,$4,$5)`,
        [order.id, item.dish_id, item.dish_name, item.price, item.quantity]
      );
    }
    await client.query('COMMIT');
    order.items = items;
    io.emit('new_order', order);

    const foodItems = items.filter(i => i.category !== 'napitki');
    if (foodItems.length) {
      const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const lines = foodItems.map(i => `  • ${i.dish_name} × ${i.quantity}`).join('\n');
      const chatIds = await getWaiterChatIds();
      await sendTelegram(chatIds, `🍽️ <b>Новый заказ на кухню</b>\n\n📍 ${table_name} · 🕐 ${time}\n👤 ${req.user.name}\n\n${lines}`);
    }
    res.json(order);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/orders/:id/add-items', auth, async (req, res) => {
  const { items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, dish_id, dish_name, dish_price, quantity) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, item.dish_id, item.dish_name, item.price, item.quantity]
      );
    }
    const addTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    await client.query('UPDATE orders SET total=total+$1 WHERE id=$2', [addTotal, req.params.id]);
    await client.query('COMMIT');

    const foodItems = items.filter(i => i.category !== 'napitki');
    if (foodItems.length) {
      const { rows } = await pool.query('SELECT table_name FROM orders WHERE id=$1', [req.params.id]);
      const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const lines = foodItems.map(i => `  • ${i.dish_name} × ${i.quantity}`).join('\n');
      const chatIds = await getWaiterChatIds();
      await sendTelegram(chatIds, `➕ <b>Дозаказ</b>\n\n📍 ${rows[0]?.table_name} · 🕐 ${time}\n\n${lines}`);
    }
    io.emit('order_updated', { id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/orders/:id/close', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET status='closed', closed_at=NOW() WHERE id=$1 AND cafe_id=$2 RETURNING *`,
      [req.params.id, CAFE_ID]
    );
    const order = rows[0];
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
    const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const lines = items.map(i => `  • ${i.dish_name} × ${i.quantity} — ${i.dish_price * i.quantity} с`).join('\n');
    const chatIds = await getWaiterChatIds();
    await sendTelegram(chatIds,
      `✅ <b>Стол закрыт</b>\n\n📍 ${order.table_name}\n👤 ${req.user.name} · 🕐 ${time}\n\n${lines}\n\n💰 <b>Итого: ${order.total} с</b>`
    );
    io.emit('order_closed', { id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/orders/:id', auth, managerOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM orders WHERE id=$1 AND cafe_id=$2', [req.params.id, CAFE_ID]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Удалить позицию из заказа
app.delete('/api/orders/:orderId/items/:itemId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM order_items WHERE id=$1 AND order_id=$2',
      [req.params.itemId, req.params.orderId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Позиция не найдена' });
    const item = rows[0];

    if (req.user.role !== 'manager') {
      const { rows: orderRows } = await pool.query(
        'SELECT * FROM orders WHERE id=$1 AND waiter_id=$2',
        [req.params.orderId, req.user.id]
      );
      if (!orderRows.length) return res.status(403).json({ error: 'Нет доступа' });
    }

    await pool.query('DELETE FROM order_items WHERE id=$1', [req.params.itemId]);
    await pool.query(
      'UPDATE orders SET total = total - $1 WHERE id=$2',
      [item.dish_price * item.quantity, req.params.orderId]
    );
    io.emit('order_updated', { id: parseInt(req.params.orderId) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ВЫЗОВ ОФИЦИАНТА ----

app.post('/api/call-waiter', async (req, res) => {
  const { table_name } = req.body;
  if (!table_name) return res.status(400).json({ error: 'table_name required' });
  try {
    await pool.query('INSERT INTO waiter_calls (cafe_id, table_name) VALUES ($1,$2)', [CAFE_ID, table_name]);
    const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const chatIds = await getWaiterChatIds();
    await sendTelegram(chatIds, `🔔 <b>Вызов официанта!</b>\n\n📍 ${table_name}\n🕐 ${time}`);
    io.emit('waiter_called', { table: table_name, time });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- ПЕРСОНАЛ ----

app.get('/api/staff', auth, managerOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, login, role, telegram_chat_id, is_active FROM staff WHERE cafe_id=$1 ORDER BY name`,
      [CAFE_ID]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff', auth, managerOnly, async (req, res) => {
  const { name, login, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO staff (cafe_id, name, login, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, login, role`,
      [CAFE_ID, name, login, hash, role]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/staff/:id', auth, managerOnly, async (req, res) => {
  const { name, login, password, role, telegram_chat_id } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE staff SET name=$1, login=$2, role=$3, telegram_chat_id=$4, password_hash=$5 WHERE id=$6`,
        [name, login, role, telegram_chat_id || null, hash, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE staff SET name=$1, login=$2, role=$3, telegram_chat_id=$4 WHERE id=$5`,
        [name, login, role, telegram_chat_id || null, req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/staff/:id', auth, managerOnly, async (req, res) => {
  try {
    await pool.query('UPDATE staff SET is_active=FALSE WHERE id=$1 AND cafe_id=$2', [req.params.id, CAFE_ID]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- СТАТИСТИКА ----

app.get('/api/stats', auth, managerOnly, async (req, res) => {
  const bishkekNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const date = req.query.date || bishkekNow.toISOString().split('T')[0];
  const startUTC = new Date(date + 'T00:00:00+06:00');
  const endUTC = new Date(date + 'T23:59:59+06:00');
  try {
    const { rows: rev } = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(total),0) as revenue FROM orders
       WHERE cafe_id=$1 AND status='closed' AND created_at >= $2 AND created_at <= $3`,
      [CAFE_ID, startUTC.toISOString(), endUTC.toISOString()]
    );
    const { rows: topDishes } = await pool.query(
      `SELECT oi.dish_name, SUM(oi.quantity) as qty, SUM(oi.quantity*oi.dish_price) as revenue
       FROM order_items oi JOIN orders o ON oi.order_id=o.id
       WHERE o.cafe_id=$1 AND o.status='closed' AND o.created_at >= $2 AND o.created_at <= $3
       GROUP BY oi.dish_name ORDER BY qty DESC LIMIT 10`,
      [CAFE_ID, startUTC.toISOString(), endUTC.toISOString()]
    );
    const { rows: byWaiter } = await pool.query(
      `SELECT waiter_name, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE cafe_id=$1 AND status='closed' AND created_at >= $2 AND created_at <= $3
       GROUP BY waiter_name ORDER BY revenue DESC`,
      [CAFE_ID, startUTC.toISOString(), endUTC.toISOString()]
    );
    const { rows: open } = await pool.query(
      `SELECT COUNT(*) as count FROM orders WHERE cafe_id=$1 AND status='open'`, [CAFE_ID]
    );
    // Неделя — последние 7 дней по Бишкеку
    const { rows: week } = await pool.query(
      `SELECT 
         TO_CHAR(created_at + INTERVAL '6 hours', 'YYYY-MM-DD') as day,
         COALESCE(SUM(total),0) as revenue
       FROM orders WHERE cafe_id=$1 AND status='closed'
       AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY day ORDER BY day`,
      [CAFE_ID]
    );
    res.json({
      revenue: parseInt(rev[0].revenue),
      orders: parseInt(rev[0].count),
      avg: rev[0].count > 0 ? Math.round(rev[0].revenue / rev[0].count) : 0,
      open_tables: parseInt(open[0].count),
      top_dishes: topDishes,
      by_waiter: byWaiter,
      week,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- TELEGRAM WEBHOOK ----

app.post('/bot-webhook', async (req, res) => {
  const update = req.body;
  if (update.message?.text === '/start') {
    const chatId = update.message.chat.id;
    const name   = update.message.from.first_name || 'Сотрудник';
    await sendTelegram([chatId],
      `👋 Привет, <b>${name}</b>!\n\nЭто бот кафе <b>Ak-Kalpak</b>.\n\nТвой Chat ID: <code>${chatId}</code>\n\nПередай этот номер менеджеру.`
    );
    console.log(`Новый TG пользователь: ${name} — ${chatId}`);
  }
  res.json({ ok: true });
});

// ---- WEBSOCKET ----

io.on('connection', socket => {
  console.log(`WS: ${socket.id} подключился`);
  socket.on('disconnect', () => console.log(`WS: ${socket.id} отключился`));
});

// ---- ЗАПУСК ----

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Ak-Kalpak API v1' }));

// Только для первоначальной настройки — получить хеш пароля
// После создания первого менеджера этот endpoint можно удалить
app.get('/api/auth/hash', async (req, res) => {
  const { password } = req.query;
  if (!password) return res.status(400).json({ error: 'password required' });
  const hash = await bcrypt.hash(password, 10);
  res.json({ hash, sql: `UPDATE staff SET password_hash='${hash}' WHERE login='manager';` });
});

server.listen(PORT, () => {
  console.log(`\n✅ Сервер запущен: http://localhost:${PORT}`);
  console.log(`📦 БД: ${DATABASE_URL ? 'OK' : '⚠️  DATABASE_URL не задан'}`);
  console.log(`🤖 Telegram: ${TG_TOKEN ? 'OK' : '⚠️  TELEGRAM_TOKEN не задан'}\n`);
});
