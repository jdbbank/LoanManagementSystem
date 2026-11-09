import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { motion, transition } from '../theme';
import { compactAmount } from '../utils/format';
import type { AccentColor } from './TrendChart';

export interface DonutSlice {
  id: string;
  label: string;
  color: AccentColor;
  value: number;
}

interface ShareDonutProps {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
}

const RADIUS = 44;
const STROKE = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** A hair of empty ring between slices keeps adjacent hues from reading as one block. */
const GAP = 1.5;

/** Dash-offset ring segments instead of arc paths: no degenerate geometry when a slice is 0% or 100%. */
export default function ShareDonut({ slices, centerLabel, centerValue }: ShareDonutProps) {
  const theme = useTheme();
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  const shares = slices.map((slice) => (total === 0 ? 0 : Math.max(0, slice.value) / total));
  const segments = slices.map((slice, index) => {
    const share = shares[index];
    const before = shares.slice(0, index).reduce((sum, value) => sum + value, 0);
    const dash = total === 0 || share === 0 ? 0 : Math.max(1, share * CIRCUMFERENCE - GAP);
    return { slice, share, dash, offset: -(before * CIRCUMFERENCE) };
  });

  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
      <Box sx={{ position: 'relative', width: 132, height: 132, flexShrink: 0 }}>
        <svg viewBox="0 0 120 120" width="100%" height="100%" role="img" aria-label={centerLabel}>
          <circle cx={60} cy={60} r={RADIUS} fill="none" stroke={theme.palette.divider} strokeWidth={STROKE} opacity={0.35} />
          <g transform="rotate(-90 60 60)">
            {segments.map(({ slice, dash, offset }) => (
              <circle
                key={slice.id}
                cx={60}
                cy={60}
                r={RADIUS}
                fill="none"
                stroke={theme.palette[slice.color].main}
                strokeWidth={dash > 0 ? STROKE : 0}
                strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                strokeDashoffset={offset}
                style={{ transition: `${transition('stroke-dasharray', motion.slow)}, ${transition('stroke-dashoffset', motion.slow)}` }}
              />
            ))}
          </g>
        </svg>
        <Stack sx={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <Typography variant="caption" color="text.secondary">
            {centerLabel}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {centerValue}
          </Typography>
        </Stack>
      </Box>

      <Stack spacing={0.75} sx={{ flexGrow: 1, minWidth: 160 }}>
        {segments.map(({ slice, share }) => (
          <Stack key={slice.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: theme.palette[slice.color].main, flexShrink: 0 }} />
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              {slice.label}
            </Typography>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {compactAmount(slice.value)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ width: 44, textAlign: 'right' }}>
              {(share * 100).toFixed(1)}%
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
