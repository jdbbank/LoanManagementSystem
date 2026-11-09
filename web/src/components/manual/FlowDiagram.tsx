import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import { useId } from 'react';
import type { AccentColor } from '../TrendChart';

/**
 * Hand-plotted flow sheets for the user manual: no diagram dependency, and the arrows are drawn
 * from the same row grid the boxes sit on, so editing a step can never leave an arrow pointing at
 * nothing. Every string in a sheet — including the colour key — comes from the spec, so the English
 * edition gets English boxes and the Thai edition gets Thai ones.
 */

export type NodeKind = 'step' | 'gate' | 'money' | 'stop' | 'end';

interface Box1 {
  kind: NodeKind;
  title: string;
  sub?: string;
}

interface Row {
  main?: Box1;
  /** A branch drawn to the right of this row's main box. */
  side?: Box1 & { label?: string; returnsToRow?: number; returnLabel?: string };
}

interface FlowSpec {
  /** Shown in the sheet header — the question the picture answers. */
  heading: string;
  caption: string;
  /** The colour key under the picture, in the language of the edition being read. */
  legend: Record<NodeKind, string>;
  rows: Row[];
}

const COL_MAIN_X = 16;
const COL_SIDE_X = 402;
const BOX_W = 356;
const BOX_H = 68;
const ROW_GAP = 26;
const PAD_TOP = 10;
const PAD_BOTTOM = 14;

const TONE: Record<NodeKind, AccentColor> = {
  step: 'primary',
  gate: 'warning',
  money: 'success',
  stop: 'error',
  end: 'secondary',
};

const rowY = (index: number) => PAD_TOP + index * (BOX_H + ROW_GAP);

/** Straight down the main column. */
const downPath = (x: number, fromRow: number, toRow: number) =>
  `M${x},${rowY(fromRow) + BOX_H} L${x},${rowY(toRow)}`;

/** Out to the branch box on the same row. */
const outPath = (fromRow: number) =>
  `M${COL_MAIN_X + BOX_W},${rowY(fromRow) + BOX_H / 2} L${COL_SIDE_X},${rowY(fromRow) + BOX_H / 2}`;

/** Back from the branch into a lower row of the main column: down the right channel, then left. */
const backPath = (fromRow: number, toRow: number) => {
  const x = COL_SIDE_X + BOX_W / 2;
  const y = rowY(toRow) + BOX_H / 2;
  return `M${x},${rowY(fromRow) + BOX_H} L${x},${y} L${COL_MAIN_X + BOX_W},${y}`;
};

function NodeBox({ box, x, y }: { box: Box1; x: number; y: number }) {
  const theme = useTheme();
  const palette = theme.palette[TONE[box.kind]];
  const strong = box.kind === 'gate' || box.kind === 'stop';
  return (
    <foreignObject x={x} y={y} width={BOX_W} height={BOX_H}>
      <Box
        sx={{
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          pl: 1.6,
          pr: 1.2,
          py: 0.8,
          borderRadius: '10px',
          border: `1.5px solid ${alpha(palette.main, strong ? 0.9 : 0.45)}`,
          borderLeft: `5px solid ${palette.main}`,
          bgcolor: alpha(palette.main, theme.palette.mode === 'dark' ? 0.14 : 0.07),
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 0.25,
        }}
      >
        <Box component="span" sx={{ fontSize: 13.5, fontWeight: 750, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
          {box.title}
        </Box>
        {box.sub && (
          <Box component="span" sx={{ fontSize: 11.5, lineHeight: 1.4, color: 'text.secondary' }}>
            {box.sub}
          </Box>
        )}
      </Box>
    </foreignObject>
  );
}

function EdgeLabel({ x, y, text }: { x: number; y: number; text: string }) {
  const theme = useTheme();
  return (
    <foreignObject x={x} y={y} width={BOX_W * 0.7} height={ROW_GAP + 6}>
      <Box
        sx={{
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1.25,
          color: 'text.secondary',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          bgcolor: theme.palette.background.paper,
        }}
      >
        {text}
      </Box>
    </foreignObject>
  );
}

export default function FlowDiagram({ spec }: { spec: FlowSpec }) {
  const theme = useTheme();
  /** Four sheets sit on one page, so each gets its own marker id instead of every svg redeclaring `flow-arrow`. */
  const marker = `flow-arrow${useId().replace(/\W/g, '')}`;
  const height = rowY(spec.rows.length - 1) + BOX_H + PAD_BOTTOM;
  const width = COL_SIDE_X + BOX_W + 16;
  const mainIndexes = spec.rows.map((row, index) => (row.main ? index : -1)).filter((index) => index >= 0);

  return (
    <Paper variant="outlined" sx={{ my: 2.5, p: 2, borderColor: 'divider' }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.25 }}>
        {spec.heading}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', mb: 1.5, color: 'text.secondary', lineHeight: 1.5 }}>
        {spec.caption}
      </Typography>

      <Box sx={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 620, height: 'auto' }} role="img" aria-label={spec.heading}>
          <defs>
            <marker id={marker} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L9,4.5 L0,9 z" fill={theme.palette.text.secondary} />
            </marker>
          </defs>

          {/* main column arrows, from each box to the next box that has one */}
          {mainIndexes.map((index, position) => {
            const next = mainIndexes[position + 1];
            if (next === undefined) return null;
            const x = COL_MAIN_X + BOX_W / 2;
            return (
              <path
                key={`down-${index}`}
                d={downPath(x, index, next)}
                stroke={theme.palette.divider}
                strokeWidth={2}
                fill="none"
                markerEnd={`url(#${marker})`}
              />
            );
          })}

          {spec.rows.map((row, index) => {
            if (!row.side) return null;
            const stroke = theme.palette[TONE[row.side.kind]].main;
            const returnTo = row.side.returnsToRow;
            return (
              <g key={`side-${index}`}>
                <path
                  d={outPath(index)}
                  stroke={stroke}
                  strokeWidth={2}
                  fill="none"
                  markerEnd={`url(#${marker})`}
                  strokeDasharray={returnTo === undefined ? undefined : '6 4'}
                />
                {row.side.label && <EdgeLabel x={COL_MAIN_X + BOX_W + 8} y={rowY(index) + BOX_H / 2 - ROW_GAP / 2 - 3} text={row.side.label} />}
                {returnTo !== undefined && (
                  <>
                    <path
                      d={backPath(index, returnTo)}
                      stroke={stroke}
                      strokeWidth={2}
                      fill="none"
                      strokeDasharray="6 4"
                      markerEnd={`url(#${marker})`}
                    />
                    {row.side.returnLabel && (
                      <EdgeLabel x={COL_SIDE_X + BOX_W / 2 - 118} y={rowY(index) + BOX_H + 2} text={row.side.returnLabel} />
                    )}
                  </>
                )}
              </g>
            );
          })}

          {spec.rows.map((row, index) => (
            <g key={`cell-${index}`}>
              {row.main && <NodeBox x={COL_MAIN_X} y={rowY(index)} box={row.main} />}
              {row.side && <NodeBox x={COL_SIDE_X} y={rowY(index)} box={row.side} />}
            </g>
          ))}
        </svg>
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
        {(Object.keys(TONE) as NodeKind[]).map((kind) => (
          <Stack key={kind} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '4px',
                bgcolor: alpha(theme.palette[TONE[kind]].main, 0.14),
                border: `1.5px solid ${theme.palette[TONE[kind]].main}`,
                borderLeftWidth: 4,
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {spec.legend[kind]}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}

export type { FlowSpec };
