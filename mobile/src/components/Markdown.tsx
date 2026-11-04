/**
 * An agent's reply, rendered natively: paragraphs, headings, lists (nested,
 * tasks), quotes, code with Copy, tables that scroll sideways, links. `marked`
 * tokenises; everything is drawn with RN views and nested Text, so selection
 * and Dynamic Type behave like the rest of the app.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Lexer, type Token, type Tokens } from 'marked';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { alpha, colors, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { T } from './ui';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }), [text]);
  return <View style={styles.root}>{blocks(tokens)}</View>;
});

function blocks(tokens: Token[]): ReactNode[] {
  return tokens.map((t, i) => block(t, i)).filter(Boolean);
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
        <Text key={key} style={styles.p} selectable>
          {inline((t as Tokens.Paragraph).tokens)}
        </Text>
      );
    case 'text': {
      const tt = t as Tokens.Text;
      return (
        <Text key={key} style={styles.p} selectable>
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
      case 'codespan':
        return (
          <Text key={i} style={styles.codespan}>
            {decode((t as Tokens.Codespan).text)}
          </Text>
        );
      case 'link': {
        const l = t as Tokens.Link;
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
        <T variant="caption" color={colors.textMuted}>
          {lang || 'code'}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={10}
          onPress={() => {
            void Clipboard.setStringAsync(code);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
        <Text style={styles.codeText} selectable>
          {code}
        </Text>
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
