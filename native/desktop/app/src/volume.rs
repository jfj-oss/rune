//! The volume bar's curve and wheel steps (web lib/volume.ts): the left half of the bar is 0..25 %, the right half 25..100 %;
//! a wheel notch is one 5 % step.

/** % volume at the slider's midpoint: the left half is 0..25 % (fine control), the right half 25..100 %. */
pub const VOL_KNEE: f64 = 25.;
/** One wheel step, in % volume. */
pub const VOL_WHEEL_STEP: f64 = 5.;
/** Wheel / trackpad travel per step (a mouse notch counts as one step whatever it reports). */
pub const VOL_WHEEL_PX: f32 = 80.;

/** Slider position (0..1) -> volume (0..100). */
pub fn pos_to_volume(p: f64) -> f64 {
    let x = p.clamp(0., 1.);
    if x <= 0.5 { x * 2. * VOL_KNEE } else { VOL_KNEE + (x - 0.5) * 2. * (100. - VOL_KNEE) }
}
/** Volume (0..100) -> slider position (0..1); inverse of pos_to_volume. */
pub fn volume_to_pos(v: f64) -> f64 {
    let x = if v.is_finite() { v.clamp(0., 100.) } else { 0. };
    if x <= VOL_KNEE { x / (2. * VOL_KNEE) } else { 0.5 + (x - VOL_KNEE) / (2. * (100. - VOL_KNEE)) }
}
/** Quantise a dragged volume like the web: 0.5 steps below the knee, whole percents above. */
pub fn snap_volume(v: f64) -> f64 {
    let x = if v.is_finite() { v.clamp(0., 100.) } else { 0. };
    if x < VOL_KNEE { (x / 0.5).round() * 0.5 } else { x.round() }
}
/** n wheel steps from v (positive = up): lands on multiples of 5 %, clamped. */
pub fn wheel_step(v: f64, n: i32) -> f64 {
    let base = if n > 0 { (v / VOL_WHEEL_STEP + 1e-9).floor() } else { (v / VOL_WHEEL_STEP - 1e-9).ceil() };
    ((base + n as f64) * VOL_WHEEL_STEP).clamp(0., 100.)
}

#[cfg(test)]
mod volume_tests {
    use super::*;
    #[test]
    fn the_curve_matches_the_web() {
        assert_eq!(pos_to_volume(0.25), 12.5);
        assert_eq!(pos_to_volume(0.5), 25.);
        assert_eq!(pos_to_volume(0.75), 62.5);
        for v in [0., 3.5, 12.5, 25., 40., 62.5, 100.] { assert!((pos_to_volume(volume_to_pos(v)) - v).abs() < 1e-9); }
        assert_eq!(snap_volume(12.3), 12.5);
        assert_eq!(snap_volume(40.4), 40.);
    }
    #[test]
    fn wheel_steps_are_five_percent_on_the_grid() {
        assert_eq!(wheel_step(40., 1), 45.);
        assert_eq!(wheel_step(42., 1), 45.);
        assert_eq!(wheel_step(42., -1), 40.);
        assert_eq!(wheel_step(40., -2), 30.);
        assert_eq!(wheel_step(98., 1), 100.);
        assert_eq!(wheel_step(2., -1), 0.);
    }
}
