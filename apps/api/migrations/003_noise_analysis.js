exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE noise_reports
      ADD COLUMN analysis JSONB;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE noise_reports
      DROP COLUMN analysis;
  `);
};
