-- ================================================
-- Ak-Kalpak — Схема базы данных PostgreSQL
-- Выполнить в Supabase → SQL Editor
-- ================================================

-- Кафе (на будущее — несколько кафе)
CREATE TABLE cafes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Категории меню
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Блюда
CREATE TABLE dishes (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  photo_url TEXT,
  is_hidden BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Столы
CREATE TABLE tables (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL  -- "Тапчан 1", "VIP зал" и т.д.
);

-- Сотрудники
CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  login VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('waiter', 'manager')),
  telegram_chat_id BIGINT,  -- для уведомлений
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Заказы
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  table_name VARCHAR(50) NOT NULL,
  waiter_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  waiter_name VARCHAR(50),
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  total INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP
);

-- Позиции заказа
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  dish_id INTEGER REFERENCES dishes(id) ON DELETE SET NULL,
  dish_name VARCHAR(100) NOT NULL,  -- сохраняем имя на момент заказа
  dish_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Вызовы официанта (для истории)
CREATE TABLE waiter_calls (
  id SERIAL PRIMARY KEY,
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  table_name VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================
-- Начальные данные для тестирования
-- ================================================

INSERT INTO cafes (name) VALUES ('Ak-Kalpak');

INSERT INTO categories (cafe_id, name, sort_order) VALUES
  (1, 'Завтраки', 1),
  (1, 'Закуски', 2),
  (1, 'Салаты', 3),
  (1, 'Напитки', 4),
  (1, 'Десерты', 5);

INSERT INTO dishes (cafe_id, category_id, name, description, price) VALUES
  (1, 1, 'Яйцо Бенедикт', 'Пашот, голландез, тост', 499),
  (1, 1, 'Омлет с томатами', 'Шпинат, базилик, сыр', 360),
  (1, 1, 'Панкейки с тирамису', 'Клубника, маскарпоне', 490),
  (1, 1, 'Английский завтрак', 'Колбаски, бекон, тост', 690),
  (1, 2, 'Брускетта с лососем', 'Крем-сыр, каперсы', 250),
  (1, 2, 'Сырные крокеты', 'Моцарелла, маринара', 390),
  (1, 3, 'Цезарь с курицей', 'Романо, пармезан', 450),
  (1, 4, 'Капучино', 'Двойной эспрессо', 120),
  (1, 4, 'Лимонад манго', 'Домашний, с мятой', 180),
  (1, 5, 'Тирамису', 'Савоярди, маскарпоне', 350);

INSERT INTO tables (cafe_id, name) VALUES
  (1, 'Стол 1'), (1, 'Стол 2'), (1, 'Стол 3'),
  (1, 'Тапчан 1'), (1, 'Тапчан 2'), (1, 'Тапчан 3'),
  (1, 'VIP зал'), (1, 'Терраса 1'), (1, 'Барная стойка');

-- Пароли: bcrypt хеш от '1111', '2222', 'admin123'
-- В реальности генерируется через bcrypt.hash()
-- Для теста используй /api/staff/create endpoint
INSERT INTO staff (cafe_id, name, login, password_hash, role) VALUES
  (1, 'Алия',    'aliya',   '$2b$10$placeholder_hash_aliya',   'waiter'),
  (1, 'Бакыт',   'bakyt',   '$2b$10$placeholder_hash_bakyt',   'waiter'),
  (1, 'Айгерим', 'manager', '$2b$10$placeholder_hash_manager', 'manager');

-- ================================================
-- Индексы для быстрых запросов
-- ================================================
CREATE INDEX idx_orders_cafe_date ON orders(cafe_id, created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_dishes_cafe_cat ON dishes(cafe_id, category_id);
CREATE INDEX idx_staff_login ON staff(login);
