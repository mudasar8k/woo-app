-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL CHECK (role IN ('super_admin', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stores table
CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  store_url VARCHAR(500) NOT NULL,
  consumer_key VARCHAR(255) NOT NULL,
  consumer_secret VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'syncing')),
  price_rule_percent DECIMAL(6, 2) DEFAULT NULL,
  last_sync_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Global app settings (e.g. default_price_rule_percent)
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (key, value)
VALUES ('default_price_rule_percent', NULL)
ON CONFLICT (key) DO NOTHING;

-- Vendors table
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  contact_info TEXT,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Vendor-Stores relationship (many-to-many)
CREATE TABLE IF NOT EXISTS vendor_stores (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vendor_id, store_id)
);

-- Admin-Store assignment
CREATE TABLE IF NOT EXISTS admin_stores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, store_id)
);

-- CSV Uploads table
CREATE TABLE IF NOT EXISTS csv_uploads (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_type VARCHAR(50) NOT NULL CHECK (file_type IN ('products', 'variations')),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500),
  row_count INTEGER DEFAULT 0,
  expected_row_count INTEGER,
  processed_row_count INTEGER DEFAULT 0,
  last_chunk_index INTEGER DEFAULT -1,
  total_chunks INTEGER,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products table (from CSV)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  csv_upload_id INTEGER NOT NULL REFERENCES csv_uploads(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sku VARCHAR(255),
  name VARCHAR(500) NOT NULL,
  description TEXT,
  short_description TEXT,
  price DECIMAL(10, 2),
  regular_price DECIMAL(10, 2),
  sale_price DECIMAL(10, 2),
  stock_quantity INTEGER,
  manage_stock BOOLEAN DEFAULT false,
  stock_status VARCHAR(50) DEFAULT 'instock',
  categories TEXT,
  tags TEXT,
  images TEXT,
  attributes TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'synced')),
  review_notes TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  woo_product_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, sku)
);

-- Product Variations table (from CSV)
CREATE TABLE IF NOT EXISTS product_variations (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  csv_upload_id INTEGER NOT NULL REFERENCES csv_uploads(id) ON DELETE CASCADE,
  parent_sku VARCHAR(255),
  sku VARCHAR(255),
  attributes TEXT,
  size VARCHAR(255),
  color VARCHAR(255),
  price DECIMAL(10, 2),
  regular_price DECIMAL(10, 2),
  sale_price DECIMAL(10, 2),
  stock_quantity INTEGER,
  manage_stock BOOLEAN DEFAULT false,
  stock_status VARCHAR(50) DEFAULT 'instock',
  tax_class VARCHAR(100),
  image VARCHAR(500),
  images TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'synced')),
  woo_variation_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, sku)
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  woo_order_id INTEGER NOT NULL,
  order_number VARCHAR(255),
  status VARCHAR(50) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  total DECIMAL(10, 2) NOT NULL,
  subtotal DECIMAL(10, 2),
  tax_total DECIMAL(10, 2),
  shipping_total DECIMAL(10, 2),
  customer_email VARCHAR(255),
  customer_name VARCHAR(255),
  billing_address TEXT,
  shipping_address TEXT,
  line_items JSONB,
  payment_method VARCHAR(255),
  payment_method_title VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, woo_order_id)
);

-- Sync Logs table
CREATE TABLE IF NOT EXISTS sync_logs (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sync_type VARCHAR(50) NOT NULL CHECK (sync_type IN ('products', 'orders', 'full')),
  status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  items_processed INTEGER DEFAULT 0,
  items_succeeded INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  initiated_by INTEGER REFERENCES users(id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_csv_upload_id ON products(csv_upload_id);
CREATE INDEX IF NOT EXISTS idx_variations_product_id ON product_variations(product_id);
CREATE INDEX IF NOT EXISTS idx_variations_sku ON product_variations(sku);
CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_woo_order_id ON orders(woo_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_store_id ON sync_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_admin_stores_user_id ON admin_stores(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_stores_store_id ON admin_stores(store_id);
CREATE INDEX IF NOT EXISTS idx_vendor_stores_vendor_id ON vendor_stores(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_stores_store_id ON vendor_stores(store_id);






