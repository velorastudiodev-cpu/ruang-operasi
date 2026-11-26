CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'warehouse')),
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  token_hash text PRIMARY KEY,
  user_id integer UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  stock integer NOT NULL CHECK (stock >= 0),
  min_stock integer NOT NULL CHECK (min_stock >= 0),
  is_active boolean NOT NULL DEFAULT true,
  alert_enqueued_at timestamptz
);

CREATE TABLE IF NOT EXISTS orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'refunded')),
  customer_name text NOT NULL,
  customer_contact text NOT NULL DEFAULT '',
  total_amount bigint NOT NULL CHECK (total_amount BETWEEN 0 AND 100000000000),
  refunded_amount bigint NOT NULL DEFAULT 0 CHECK (refunded_amount BETWEEN 0 AND total_amount),
  ordered_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  UNIQUE(channel, order_no)
);
CREATE INDEX IF NOT EXISTS orders_ordered_at ON orders(ordered_at, id);
CREATE INDEX IF NOT EXISTS orders_status_date ON orders(status, ordered_at, id);
CREATE INDEX IF NOT EXISTS orders_channel_date ON orders(channel, ordered_at, id);
CREATE INDEX IF NOT EXISTS orders_order_no ON orders(order_no);

CREATE TABLE IF NOT EXISTS order_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_price bigint NOT NULL CHECK (unit_price >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order_id ON order_items(order_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id),
  delta integer NOT NULL CHECK (delta <> 0),
  reason text NOT NULL,
  ref_type text NOT NULL,
  ref_id text,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_product_date ON stock_movements(product_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id integer REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_date ON audit_logs(created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_audit_logs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only';
END;
$$;
DROP TRIGGER IF EXISTS audit_logs_read_only ON audit_logs;
CREATE TRIGGER audit_logs_read_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_logs();

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('export', 'email')),
  owner_id integer REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  payload jsonb NOT NULL,
  result_path text,
  row_count integer,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(available_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner_id, kind, created_at DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS sales_daily AS
SELECT (ordered_at AT TIME ZONE 'Asia/Jakarta')::date AS day, channel,
  count(*) AS orders,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  count(*) FILTER (WHERE status IN ('paid','processing','shipped','completed')) AS revenue_orders,
  coalesce(sum(total_amount - refunded_amount) FILTER (
    WHERE status IN ('paid','processing','shipped','completed')), 0) AS revenue
FROM orders GROUP BY 1, 2;
CREATE UNIQUE INDEX IF NOT EXISTS sales_daily_day_channel ON sales_daily(day, channel);
