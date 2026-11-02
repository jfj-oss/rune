// Process-local "is a library scan running?" flag.
//
// The scanner sets it while scan() runs; background workers (loudness analysis)
// use it to pause, because scanning and decoding several big FLACs at once is
// exactly the I/O storm both must avoid.

let activeScans = 0;

export function beginScan(): void {
  activeScans += 1;
}

export function endScan(): void {
  if (activeScans > 0) activeScans -= 1;
}

export function isScanRunning(): boolean {
  return activeScans > 0;
}
