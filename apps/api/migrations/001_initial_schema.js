exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS postgis;

    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'citizen'
        CHECK (role IN ('citizen', 'official', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens(user_id);

    CREATE TABLE noise_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      geom geometry(Point, 4326) NOT NULL,
      db_level REAL,
      predicted_class TEXT,
      confidence REAL,
      user_label TEXT,
      audio_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      is_simulated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX noise_reports_geom_gix ON noise_reports USING GIST(geom);
    CREATE INDEX noise_reports_created_at_idx ON noise_reports(created_at);

    CREATE TABLE air_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      geom geometry(Point, 4326) NOT NULL,
      image_path TEXT,
      predicted_band TEXT,
      confidence REAL,
      mode TEXT NOT NULL DEFAULT 'fallback',
      user_label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      is_simulated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX air_reports_geom_gix ON air_reports USING GIST(geom);
    CREATE INDEX air_reports_created_at_idx ON air_reports(created_at);

    CREATE TABLE station_readings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      provider_station_id TEXT NOT NULL,
      station_name TEXT,
      geom geometry(Point, 4326) NOT NULL,
      pm25 REAL,
      aqi REAL,
      observed_at TIMESTAMPTZ NOT NULL,
      is_simulated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, provider_station_id, observed_at)
    );
    CREATE INDEX station_readings_geom_gix ON station_readings USING GIST(geom);
    CREATE INDEX station_readings_observed_at_idx ON station_readings(observed_at);

    CREATE TABLE zones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      geom geometry(Geometry, 4326) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX zones_geom_gix ON zones USING GIST(geom);

    CREATE TABLE hotspots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category TEXT NOT NULL CHECK (category IN ('noise', 'air', 'combined')),
      geom geometry(Geometry, 4326) NOT NULL,
      intensity REAL NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX hotspots_geom_gix ON hotspots USING GIST(geom);

    CREATE TABLE forecasts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      zone_id UUID REFERENCES zones(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('noise', 'air')),
      forecast_at TIMESTAMPTZ NOT NULL,
      value REAL NOT NULL,
      model_version TEXT,
      is_simulated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX forecasts_zone_time_idx ON forecasts(zone_id, forecast_at);

    CREATE TABLE alert_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('noise', 'air')),
      threshold REAL NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
      category TEXT NOT NULL CHECK (category IN ('noise', 'air')),
      geom geometry(Point, 4326),
      message TEXT NOT NULL,
      is_simulated BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX alerts_geom_gix ON alerts USING GIST(geom);

    CREATE TABLE flagged_zones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      zone_id UUID REFERENCES zones(id) ON DELETE SET NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      geom geometry(Geometry, 4326) NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX flagged_zones_geom_gix ON flagged_zones USING GIST(geom);

    CREATE TABLE model_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task TEXT NOT NULL,
      version TEXT NOT NULL,
      mode TEXT NOT NULL,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(task, version)
    );

    CREATE TABLE training_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id UUID,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_created_at_idx ON audit_log(created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_log, training_jobs, model_versions, flagged_zones,
      alerts, alert_rules, forecasts, hotspots, zones, station_readings,
      air_reports, noise_reports, refresh_tokens, users CASCADE;
  `);
};
