exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE noise_reports
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'stub',
      ADD COLUMN model_version TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE noise_reports
      DROP COLUMN model_version,
      DROP COLUMN mode;
  `);
};
