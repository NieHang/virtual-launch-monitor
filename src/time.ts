export function toBeijingIsoString(date: Date): string {
  const chinaStandardTimeOffsetMs = 8 * 60 * 60 * 1000;
  return new Date(date.getTime() + chinaStandardTimeOffsetMs).toISOString().replace("Z", "+08:00");
}
