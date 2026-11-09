import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface StatCardProps {
  title: string;
  value: string;
  hint?: string;
  /**
   * Movement against the previous period. `percent` is null when there is no comparable period,
   * which is not the same as zero, so the tile simply omits the arrow.
   */
  delta?: { percent: number | null; caption?: string };
  /** Outstanding and penalty tiles worsen as the number climbs, so an increase is not good news. */
  positiveIsGood?: boolean;
}

export default function StatCard({ title, value, hint, delta, positiveIsGood = true }: StatCardProps) {
  const up = delta?.percent !== undefined && delta?.percent !== null && delta.percent > 0;
  const down = delta?.percent !== undefined && delta?.percent !== null && delta.percent < 0;
  const moving = up || down;
  const good = (up && positiveIsGood) || (down && !positiveIsGood);

  return (
    <Card>
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {title}
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5 }}>
          {value}
        </Typography>
        {delta && (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5 }}>
            {moving &&
              (up ? (
                <ArrowUpwardIcon sx={{ fontSize: 15, color: good ? 'success.main' : 'error.main' }} />
              ) : (
                <ArrowDownwardIcon sx={{ fontSize: 15, color: good ? 'success.main' : 'error.main' }} />
              ))}
            <Typography
              variant="caption"
              sx={{ fontWeight: 700, color: moving ? (good ? 'success.main' : 'error.main') : 'text.secondary' }}
            >
              {delta.percent === null ? '-' : `${delta.percent > 0 ? '+' : ''}${delta.percent.toFixed(2)}%`}
            </Typography>
            {delta.caption && (
              <Typography variant="caption" color="text.secondary">
                {delta.caption}
              </Typography>
            )}
          </Stack>
        )}
        {hint && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: delta ? 0.5 : 0 }}>
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
