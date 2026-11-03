import { DitherLogo } from './DitherLogo';

/** The in-app mark: a dithered ladybird in the backdrop's colours (see DitherLogo). The old static mark is still at
    web/public/icons/mark.svg (it is also what the PWA icons were drawn from). */
export function Logo({ size = 28 }: { size?: number }) {
  return <DitherLogo size={size} />;
}
