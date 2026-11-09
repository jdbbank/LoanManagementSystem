import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { motion, transition } from '../theme';
import { compactAmount } from '../utils/format';

export type AccentColor = 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'error';

export interface TrendSeries {
  id: string;
  label: string;
  color: AccentColor;
  points: number[];
  /** Optional dash pattern so two series stay separable without relying on hue alone. */
  dash?: string;
}

interface TrendChartProps {
  categories: string[];
  series: TrendSeries[];
  height?: number;
  area?: boolean;
  activeIndex?: number | null;
  onSelect?: (index: number | null) => void;
  /** Axis labels stay compact; the table below still shows the exact amount. */
  compact?: (value: number) => string;
}

const VIEW_W = 720;
const PAD = { left: 58, right: 10, top: 12, bottom: 26 };

/** Small hand-plotted SVG: no chart dependency, and the series stay readable at any column count. */
export default function TrendChart({
  categories,
  series,
  height = 200,
  area = true,
  activeIndex = null,
  onSelect,
  compact = compactAmount,
}: TrendChartProps) {
  const theme = useTheme();
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;
  const values = series.flatMap((line) => line.points);
  /** A reversal-heavy month can have negative collected, so the domain floors at the lowest point. */
  const ceil = Math.max(1, ...values);
  const floor = Math.min(0, ...values);
  const span = ceil - floor || 1;
  const step = categories.length > 1 ? plotW / (categories.length - 1) : 0;
  const xAt = (index: number) => PAD.left + (categories.length > 1 ? index * step : plotW / 2);
  const yAt = (value: number) => base - ((value - floor) / span) * plotH;
  const colorFor = (color: AccentColor) => theme.palette[color].main;

  const linePath = (points: number[]) =>
    points.map((value, index) => `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(' ');
  const areaPath = (points: number[]) =>
    points.length
      ? `${linePath(points)} L${xAt(points.length - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`
      : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => floor + ratio * span);
  const labelEvery = Math.ceil(categories.length / 8);
  const columnW = Math.max(14, Math.min(56, step || plotW));

  return (
    <Box
      sx={{
        '& [data-column]': { cursor: 'pointer' },
        '& [data-column]:hover': { fill: theme.palette.action.hover },
        '& [data-column]:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
        '& circle': { transition: transition('r', motion.quick) },
      }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        role="img"
        width="100%"
        aria-label={series.map((line) => `${line.label}: ${line.points.map(compact).join(', ')}`).join(' | ')}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={yAt(tick)} y2={yAt(tick)} stroke={theme.palette.divider} strokeWidth={1} />
            <text x={PAD.left - 8} y={yAt(tick) + 4} textAnchor="end" fontSize={11} fill={theme.palette.text.secondary}>
              {compact(tick)}
            </text>
          </g>
        ))}

        {floor < 0 && (
          <line
            x1={PAD.left}
            x2={VIEW_W - PAD.right}
            y1={yAt(0)}
            y2={yAt(0)}
            stroke={theme.palette.text.secondary}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.75}
          />
        )}

        {series.map((line, seriesIndex) => (
          <g key={line.id}>
            {area && (
              <path
                d={areaPath(line.points)}
                fill={colorFor(line.color)}
                opacity={seriesIndex === 0 ? 0.14 : 0.08}
                stroke="none"
              />
            )}
            <path
              d={linePath(line.points)}
              fill="none"
              stroke={colorFor(line.color)}
              strokeWidth={2.25}
              strokeDasharray={line.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {line.points.map((value, index) => (
              <circle
                key={index}
                cx={xAt(index)}
                cy={yAt(value)}
                r={activeIndex === index ? 4.5 : 2.75}
                fill={colorFor(line.color)}
              />
            ))}
          </g>
        ))}

        {categories.map((category, index) => (
          <text
            key={category}
            x={xAt(index)}
            y={height - 8}
            textAnchor="middle"
            fontSize={11}
            fill={activeIndex === index ? theme.palette.text.primary : theme.palette.text.secondary}
            fontWeight={activeIndex === index ? 700 : 400}
          >
            {index % labelEvery === 0 ? category : ''}
          </text>
        ))}

        {onSelect &&
          categories.map((category, index) => (
            <rect
              key={category}
              data-column
              tabIndex={0}
              role="button"
              aria-label={`${category} - ${series.map((line) => `${line.label} ${compact(line.points[index] ?? 0)}`).join(', ')}`}
              x={xAt(index) - columnW / 2}
              y={PAD.top}
              width={columnW}
              height={plotH}
              fill={activeIndex === index ? theme.palette.action.selected : 'transparent'}
              onClick={() => onSelect(activeIndex === index ? null : index)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(activeIndex === index ? null : index);
              }}
            />
          ))}
      </svg>

      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
        {series.map((line) => (
          <Stack key={line.id} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: colorFor(line.color) }} />
            <Typography variant="caption" color="text.secondary">
              {line.label}
            </Typography>
          </Stack>
        ))}
        {activeIndex !== null && (
          <Typography variant="caption" sx={{ fontWeight: 700, ml: 'auto' }}>
            {categories[activeIndex]}: {series.map((line) => `${line.label} ${compact(line.points[activeIndex] ?? 0)}`).join(' / ')}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
