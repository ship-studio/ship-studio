/**
 * An agent's reply, rendered natively: paragraphs, headings, lists (nested,
 * tasks), quotes, code with Copy, tables that scroll sideways, links. `marked`
 * tokenises; everything is drawn with RN views and nested Text, so Dynamic
 * Type behaves like the rest of the app.
 *
 * While a reply streams, only its last block is re-read on each tick: the
 * finished blocks before it are lexed once and kept (`splitStable`), so a
 * long reply costs the same per frame as a short one.
 *
 * A file path in code (`src/app/page.tsx`) or a link to one is tappable:
 * the chat fetches it from the Mac (`agents.fetchPath`) and opens it.
 */

import * as Clipboard from 'expo-clipboard';
import { Lexer, type Token, type Tokens } from 'marked';
import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { alpha, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { T } from './ui';

/** Opens a path written in a reply; absent where paths can't be opened. */
export const PathContext = createContext<((path: string) => void) | null>(null);

/**
 * Split at the last block boundary (a blank line outside a code fence):
 * everything before it is finished and won't change as more text arrives.
 */
export function splitStable(text: string): [string, string] {
  let fence: string | null = null;
  let boundary = 0;
  let at = 0;
  for (const line of text.split('\n')) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (!fence) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
    } else if (!fence && !line.trim() && at > 0) {
      boundary = at;
    }
    at += line.length + 1;
  }
  return [text.slice(0, boundary), text.slice(boundary)];
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!streaming) return <Blocks text={text} />;
  const [done, tail] = splitStable(text);
  return (
    <View style={styles.root}>
      {!!done && <Blocks text={done} />}
      {!!tail.trim() && <Blocks text={tail} />}
    </View>
  );
});

const Blocks = memo(function Blocks({ text }: { text: string }) {
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }), [text]);
  return <View style={styles.root}>{blocks(tokens)}</View>;
});

function blocks(tokens: Token[]): ReactNode[] {
  return tokens.map((t, i) => block(t, i)).filter(Boolean);
}

/** Extensions a bare name (no folder) must have to read as a file rather than code. */
const FILE_EXT =
  /\.(md|mdx|txt|pdf|png|jpe?g|gif|webp|svg|heic|json|csv|tsv|tsx?|jsx?|mjs|cjs|html?|css|scss|py|rs|go|rb|swift|kt|java|ya?ml|toml|lock|sql|sh|zip|docx?|xlsx?|pptx?|key|pages|numbers|mov|mp4|mp3|wav)$/i;

/** `src/app/page.tsx`, `./notes.md`, `/Users/x/report.pdf`: a file, not a command. */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t) || /^[a-z]+:\/\//i.test(t) || t.length > 300) return false;
  if (!/^(~|\.{1,2})?\/?([\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8}$/.test(t)) return false;
  return t.includes('/') || FILE_EXT.test(t);
}

function PathText({ path, children }: { path: string; children: ReactNode }) {
  const open = useContext(PathContext);
  if (!open) return <>{children}</>;
  return (
    <Text
      style={styles.path}
      onPress={() => open(path)}
      accessibilityRole="link"
      accessibilityHint="Opens the file from your Mac"
    >
      {children}
    </Text>
  );
}

function block(t: Token, key: number): ReactNode {
  switch (t.type) {
    case 'space':
      return null;
    case 'heading': {
      const h = t as Tokens.Heading;
      const size = h.depth <= 1 ? type.title : h.depth === 2 ? type.subhead : type.body;
      return (
        <Text
          key={key}
          style={[styles.p, styles.heading, { fontSize: size, lineHeight: lineHeight(size, 1.35) }]}
        >
          {inline(h.tokens)}
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text key={key} style={styles.p}>
          {inline((t as Tokens.Paragraph).tokens)}
        </Text>
      );
    case 'text': {
      const tt = t as Tokens.Text;
      return (
        <Text key={key} style={styles.p}>
          {tt.tokens ? inline(tt.tokens) : tt.text}
        </Text>
      );
    }
    case 'code':
      return <CodeBlock key={key} code={(t as Tokens.Code).text} lang={(t as Tokens.Code).lang} />;
    case 'blockquote':
      return (
        <View key={key} style={styles.quote}>
          {blocks((t as Tokens.Blockquote).tokens)}
        </View>
      );
    case 'list':
      return <List key={key} list={t as Tokens.List} />;
    case 'table':
      return <Table key={key} table={t as Tokens.Table} />;
    case 'hr':
      return <View key={key} style={styles.hr} />;
    case 'html':
      return (
        <Text key={key} style={styles.p}>
          {(t as Tokens.HTML).text.trim()}
        </Text>
      );
    default:
      return 'raw' in t ? (
        <Text key={key} style={styles.p}>
          {t.raw}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[] | undefined): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'strong':
        return (
          <Text key={i} style={styles.strong}>
            {inline((t as Tokens.Strong).tokens)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={styles.em}>
            {inline((t as Tokens.Em).tokens)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} style={styles.del}>
            {inline((t as Tokens.Del).tokens)}
          </Text>
        );
      case 'codespan': {
        const code = decode((t as Tokens.Codespan).text);
        const span = (
          <Text key={i} style={styles.codespan}>
            {code}
          </Text>
        );
        return looksLikePath(code) ? (
          <PathText key={i} path={code}>
            {span}
          </PathText>
        ) : (
          span
        );
      }
      case 'link': {
        const l = t as Tokens.Link;
        if (looksLikePath(l.href)) {
          return (
            <PathText key={i} path={l.href}>
              {inline(l.tokens)}
            </PathText>
          );
        }
        const safe = /^https?:\/\//i.test(l.href);
        return (
          <Text
            key={i}
            style={safe ? styles.link : undefined}
            onPress={safe ? () => void Linking.openURL(l.href) : undefined}
          >
            {inline(l.tokens)}
          </Text>
        );
      }
      case 'image':
        return <Text key={i}>{(t as Tokens.Image).text}</Text>;
      case 'br':
        return '\n';
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? <Text key={i}>{inline(tt.tokens)}</Text> : decode(tt.text);
      }
      case 'escape':
        return (t as Tokens.Escape).text;
      default:
        return 'raw' in t ? t.raw : null;
    }
  });
}

/** marked escapes entities in text tokens; the screen wants the characters. */
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function List({ list, depth = 0 }: { list: Tokens.List; depth?: number }) {
  const start = typeof list.start === 'number' ? list.start : 1;
  return (
    <View style={styles.list}>
      {list.items.map((item, i) => (
        <View key={i} style={styles.item}>
          <Text style={[styles.p, styles.bullet]}>
            {item.task
              ? item.checked
                ? '☑'
                : '☐'
              : list.ordered
                ? `${start + i}.`
                : depth
                  ? '◦'
                  : '•'}
          </Text>
          <View style={styles.itemBody}>
            {item.tokens.map((t, j) =>
              t.type === 'list' ? (
                <List key={j} list={t as Tokens.List} depth={depth + 1} />
              ) : (
                block(t, j)
              )
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

function Table({ table }: { table: Tokens.Table }) {
  // Columns sized from their longest cell, so every row lines up.
  const widths = table.header.map((h, c) => {
    const longest = Math.max(h.text.length, ...table.rows.map((r) => r[c]?.text.length ?? 0));
    return Math.min(260, Math.max(64, longest * 7.5 + space.lg * 2));
  });
  const row = (cells: Tokens.TableCell[], header: boolean, key: number) => (
    <View key={key} style={[styles.tr, header && styles.th]}>
      {cells.map((cell, c) => (
        <View key={c} style={[styles.td, { width: widths[c] }]}>
          <Text style={[styles.cell, header && styles.strong]}>{inline(cell.tokens)}</Text>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
      <View style={styles.table}>
        {row(table.header, true, -1)}
        {table.rows.map((r, i) => row(r, false, i))}
      </View>
    </ScrollView>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.code}>
      <View style={styles.codeHeader}>
        <T variant="caption" color={colors.textSecondary}>
          {lang || 'code'}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={14}
          onPress={() => {
            void Clipboard.setStringAsync(code);
            haptic.success();
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <T variant="caption" color={copied ? colors.accentActive : colors.textSecondary}>
            {copied ? 'Copied' : 'Copy'}
          </T>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.codeBody}
      >
        <Text style={styles.codeText}>{code}</Text>
      </ScrollView>
    </View>
  );
}

const body = {
  fontFamily: fonts.regular,
  fontSize: type.body,
  lineHeight: lineHeight(type.body, 1.5),
  color: colors.textPrimary,
};

const styles = StyleSheet.create({
  root: { gap: space.sm },
  p: body,
  heading: { fontFamily: fonts.semibold, color: colors.textWhite, marginTop: space.xs },
  strong: { fontFamily: fonts.semibold, color: colors.textWhite },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: colors.textSecondary },
  codespan: {
    fontFamily: fonts.mono,
    fontSize: type.small,
    color: colors.textWhite,
    backgroundColor: colors.surfaceControl,
  },
  link: { color: colors.accentFocus, textDecorationLine: 'underline' },
  path: { textDecorationLine: 'underline', textDecorationColor: colors.textMuted },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    paddingLeft: space.md,
    gap: space.sm,
  },
  list: { gap: space.xs },
  item: { flexDirection: 'row', gap: space.sm },
  bullet: { color: colors.textMuted, minWidth: 14 },
  itemBody: { flex: 1, gap: space.xs },
  hr: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderStrong,
    marginVertical: space.sm,
  },
  code: {
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  codeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  codeBody: { padding: space.md },
  codeText: {
    fontFamily: fonts.mono,
    fontSize: type.small,
    lineHeight: lineHeight(type.small, 1.5),
    color: colors.textPrimary,
  },
  tableScroll: { flexGrow: 0 },
  table: {
    overflow: 'hidden',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  th: { backgroundColor: alpha(colors.textWhite, 0.03) },
  td: { paddingHorizontal: space.md, paddingVertical: space.sm },
  cell: { ...body, fontSize: type.small, lineHeight: lineHeight(type.small, 1.45) },
});
