// Generates a unique visit token like "VIS-A3X9K2"
// We avoid letters/numbers that look alike: 0/O, 1/I/L
export function generateVisitToken() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let token = "VIS-";
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}