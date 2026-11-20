//! The 64 x 64 blue-noise rank table of the web (`blueNoise(64)` in `web/src/lib/dither.ts`), so the native dither has the same
//! grain. The table is baked (`assets/bluenoise64.bin`, 4096 little-endian u16) from the web's own output (`new Uint16Array(blueNoise(64))`),
//! and a test checks that the Rust port of the generator below makes (nearly) the same one: V8's `exp` and Rust's differ in the last
//! bit, which moves about 1.5 % of the ranks by a place or two when two cells tie.

pub const N: usize = 64;

/// The baked ranks, row-major (rank 0..4095).
pub fn table() -> Vec<u16> {
    include_bytes!("../assets/bluenoise64.bin").chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect()
}

/// Thresholds in (0,1): `(rank + 0.5) / 4096`, as the web uses them.
pub fn thresholds() -> Vec<f32> { table().iter().map(|&r| (r as f32 + 0.5) / (N * N) as f32).collect() }

#[cfg(test)]
fn rng(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b79f5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// Port of `blueNoise(n, seed)`.
#[cfg(test)]
pub fn generate(n: usize, seed: u32) -> Vec<u16> {
    let nn = n * n;
    let r_ = 6i32;
    let sigma2 = 2.0 * 1.5 * 1.5;
    let kw = (2 * r_ + 1) as usize;
    let mut kern = vec![0f64; kw * kw];
    for dy in -r_..=r_ { for dx in -r_..=r_ { kern[((dy + r_) as usize) * kw + (dx + r_) as usize] = (-((dx * dx + dy * dy) as f64) / sigma2).exp(); } }
    let mut energy = vec![0f64; nn];
    let mut bits = vec![0u8; nn];
    let splat = |energy: &mut Vec<f64>, idx: usize, sign: f64| {
        let (x0, y0) = ((idx % n) as i32, (idx / n) as i32);
        for dy in -r_..=r_ {
            let row = (((y0 + dy + n as i32) % n as i32) as usize) * n;
            for dx in -r_..=r_ { energy[row + ((x0 + dx + n as i32) % n as i32) as usize] += sign * kern[((dy + r_) as usize) * kw + (dx + r_) as usize]; }
        }
    };
    let pick = |energy: &Vec<f64>, bits: &Vec<u8>, want: u8, max: bool| -> usize {
        let (mut best, mut bv) = (usize::MAX, if max { f64::NEG_INFINITY } else { f64::INFINITY });
        for i in 0..nn {
            if bits[i] != want { continue; }
            let e = energy[i];
            if (max && e > bv) || (!max && e < bv) { bv = e; best = i; }
        }
        best
    };
    let mut rand = rng(seed);
    let ones = (nn / 10).max(1);
    let mut placed = 0;
    while placed < ones {
        let i = (rand() * nn as f64).floor() as usize;
        if bits[i] != 0 { continue; }
        bits[i] = 1; splat(&mut energy, i, 1.0); placed += 1;
    }
    for _ in 0..nn * 4 {
        let c = pick(&energy, &bits, 1, true);
        bits[c] = 0; splat(&mut energy, c, -1.0);
        let v = pick(&energy, &bits, 0, false);
        bits[v] = 1; splat(&mut energy, v, 1.0);
        if v == c { break; }
    }
    let proto = bits.clone();
    let proto_energy = energy.clone();
    let mut rank = vec![0u16; nn];
    for r in (0..ones).rev() {
        let c = pick(&energy, &bits, 1, true);
        bits[c] = 0; splat(&mut energy, c, -1.0); rank[c] = r as u16;
    }
    bits = proto; energy = proto_energy;
    let mut r = ones;
    while r < nn / 2 {
        let v = pick(&energy, &bits, 0, false);
        bits[v] = 1; splat(&mut energy, v, 1.0); rank[v] = r as u16;
        r += 1;
    }
    energy.iter_mut().for_each(|e| *e = 0.0);
    for i in 0..nn { if bits[i] == 0 { splat(&mut energy, i, 1.0); } }
    while r < nn {
        let c = pick(&energy, &bits, 0, true);
        bits[c] = 1; splat(&mut energy, c, -1.0); rank[c] = r as u16;
        r += 1;
    }
    rank
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_baked_table_is_a_permutation_and_what_the_generator_makes() {
        let t = table();
        assert_eq!(t.len(), N * N);
        let mut seen = vec![false; N * N];
        for &r in &t { assert!(!seen[r as usize], "rank {r} twice"); seen[r as usize] = true; }
        let g = generate(N, 7);
        let same = t.iter().zip(&g).filter(|(a, b)| a == b).count();
        assert!(same > N * N * 97 / 100, "only {same} of {} ranks agree with the port", N * N);
    }
}
