import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { MouseEvent, ReactNode } from 'react';
import type { SxProps, Theme } from '@mui/material/styles';
import type { Block, Inline, ListItem } from '../utils/markdown';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** Room for the fixed AppBar, so an anchor jump never buries the heading under the toolbar. */
export const ANCHOR_SCROLL_MARGIN = 96;

function CodeChip({ text }: { text: string }) {
  return (
    <Box
      component="code"
      sx={{
        px: 0.6,
        py: 0.15,
        borderRadius: 1,
        bgcolor: 'action.hover',
        fontFamily: MONO,
        fontSize: '0.9em',
        fontWeight: 600,
        wordBreak: 'break-word',
      }}
    >
      {text}
    </Box>
  );
}

/** A `#section` link scrolls inside the manual instead of asking the router for another page. */
function scrollToAnchor(event: MouseEvent<HTMLAnchorElement>, href: string) {
  const id = href.slice(1);
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.history.replaceState(null, '', `#${id}`);
}

function InlineNodes({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === 'code') return <CodeChip key={index} text={part.text} />;
        if (part.kind === 'text') return <span key={index}>{part.text}</span>;
        if (part.kind === 'strong')
          return (
            <Box key={index} component="span" sx={{ fontWeight: 700 }}>
              <InlineNodes parts={part.parts} />
            </Box>
          );
        if (part.kind === 'em')
          return (
            <Box key={index} component="span" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
              <InlineNodes parts={part.parts} />
            </Box>
          );
        const anchor = part.href.startsWith('#')
          ? { href: part.href, onClick: (event: MouseEvent<HTMLAnchorElement>) => scrollToAnchor(event, part.href) }
          : { href: part.href, target: '_blank', rel: 'noopener noreferrer' };
        return (
          <Typography
            key={index}
            component="a"
            variant="body2"
            {...anchor}
            sx={{ color: 'primary.main', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
          >
            <InlineNodes parts={part.parts} />
          </Typography>
        );
      })}
    </>
  );
}

function BodyText({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ mb: 1.25, lineHeight: 1.85 }}>
      {children}
    </Typography>
  );
}

function ListItemRow({ item }: { item: ListItem }) {
  return (
    <Box component="li" sx={{ mb: 0.5, lineHeight: 1.85 }}>
      {item.checked !== null && (
        <Checkbox
          size="small"
          checked={item.checked}
          tabIndex={-1}
          sx={{ p: 0, mr: 0.75, verticalAlign: 'middle', pointerEvents: 'none' }}
        />
      )}
      <InlineNodes parts={item.parts} />
      {item.children.length > 0 && (
        <Markdown blocks={item.children} sx={{ mt: 0.5, ml: 2 }} />
      )}
    </Box>
  );
}

function ListView({ block }: { block: Extract<Block, { kind: 'list' }> }) {
  return (
    <Box component={block.ordered ? 'ol' : 'ul'} sx={{ m: 0, mb: 1.5, pl: 3.5 }}>
      {block.items.map((item, index) => (
        <ListItemRow key={index} item={item} />
      ))}
    </Box>
  );
}

function TableView({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const alignOf = (index: number) => block.align[index] ?? 'left';
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ mb: 2, borderColor: 'divider' }}>
      <Table size="small" sx={{ minWidth: 560 }}>
        <TableHead>
          <TableRow>
            {block.head.map((cell, index) => (
              <TableCell key={index} align={alignOf(index)} sx={{ fontWeight: 750, whiteSpace: 'nowrap', bgcolor: 'action.hover' }}>
                <InlineNodes parts={cell} />
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {block.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <TableCell key={cellIndex} align={alignOf(cellIndex)} sx={{ verticalAlign: 'top', lineHeight: 1.7 }}>
                  <InlineNodes parts={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function HeadingView({ block }: { block: Extract<Block, { kind: 'heading' }> }) {
  return (
    <Typography
      id={block.id}
      component={block.level <= 2 ? 'h2' : 'h3'}
      variant={block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'subtitle1'}
      sx={{
        mt: block.level === 1 ? 0 : block.level === 2 ? 3 : 2.25,
        mb: 1.25,
        fontWeight: block.level === 3 ? 700 : 800,
        letterSpacing: '-0.01em',
        scrollMarginTop: ANCHOR_SCROLL_MARGIN,
      }}
    >
      <InlineNodes parts={block.parts} />
    </Typography>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return <HeadingView block={block} />;
    case 'paragraph':
      return (
        <BodyText>
          <InlineNodes parts={block.parts} />
        </BodyText>
      );
    case 'quote':
      return (
        <Box
          sx={{
            mb: 1.75,
            p: 1.5,
            pl: 2,
            borderLeft: '4px solid',
            borderColor: 'primary.main',
            bgcolor: 'action.hover',
            borderRadius: 1,
          }}
        >
          <BodyText>
            <InlineNodes parts={block.parts} />
          </BodyText>
        </Box>
      );
    case 'rule':
      return <Divider sx={{ my: 2.5 }} />;
    case 'code':
      return (
        <Box
          component="pre"
          sx={{
            m: 0,
            mb: 2,
            p: 1.75,
            overflowX: 'auto',
            borderRadius: 1,
            bgcolor: 'grey.900',
            color: 'common.white',
            fontFamily: MONO,
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: 'pre',
          }}
        >
          {block.text}
        </Box>
      );
    case 'list':
      return <ListView block={block} />;
    case 'table':
      return <TableView block={block} />;
  }
}

export default function Markdown({ blocks, sx }: { blocks: Block[]; sx?: SxProps<Theme> }) {
  return (
    <Stack sx={sx} spacing={0}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </Stack>
  );
}
