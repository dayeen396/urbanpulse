jest.mock("music-metadata", () => ({
  parseBuffer: async (buffer: Buffer) => ({
    format: { duration: buffer.readUInt32LE(40) / (8_000 * 2) },
  }),
}));
