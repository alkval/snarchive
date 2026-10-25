import { Children, Fragment, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View, type ImageProps, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { space, type, useReducedMotion, useTheme } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type Tone = 'info' | 'progress' | 'success' | 'warning' | 'error';
// Strong ease-out: UI responds at once, then settles. Never ease-in on UI.
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Press feedback on press-in (100ms), release in 150ms; transform and opacity only, on the native driver. */
export function PressScale({ style, children, disabled, onPressIn, onPressOut, ...props }: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(1)).current;
  const to = (target: number, duration: number) => Animated.timing(value, { toValue: target, duration, easing: EASE_OUT, useNativeDriver: true }).start();
  const motion = reduced ? { opacity: value.interpolate({ inputRange: [0.97, 1], outputRange: [0.7, 1] }) } : { transform: [{ scale: value }] };
  return <Pressable {...props} disabled={disabled} pressRetentionOffset={16}
    onPressIn={event => { to(0.97, 100); onPressIn?.(event); }} onPressOut={event => { to(1, 150); onPressOut?.(event); }}>
    <Animated.View style={[style, motion]}>{children}</Animated.View>
  </Pressable>;
}

export function Button({ label, onPress, variant = 'primary', icon, disabled = false, busy = false }: {
  label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'plain'; icon?: IconName; disabled?: boolean; busy?: boolean;
}) {
  const t = useTheme();
  const fill = variant === 'primary' ? t.primary : variant === 'secondary' ? t.raised : 'transparent';
  const ink = variant === 'primary' ? t.onPrimary : variant === 'secondary' ? t.text : t.accent;
  return <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress}
    style={[styles.button, variant === 'plain' && styles.plain, { backgroundColor: fill, opacity: disabled ? 0.4 : 1 }]}>
    {busy ? <ActivityIndicator color={ink} /> : icon ? <Ionicons name={icon} size={20} color={ink} /> : null}
    <Text style={[type.headline, { color: ink, textAlign: 'center' }]}>{label}</Text>
  </PressScale>;
}

export function LargeTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = useTheme();
  return <View style={styles.titleBlock}>
    <Text accessibilityRole="header" style={[type.largeTitle, { color: t.text }]}>{title}</Text>
    {!!subtitle && <Text style={[type.body, { color: t.secondary }]}>{subtitle}</Text>}
  </View>;
}

/** Inset grouped section: rows share one surface, split by hairlines, never boxed individually. */
export function Group({ header, footer, children, inset = 16 }: { header?: string; footer?: string; children: ReactNode; inset?: number }) {
  const t = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return <View style={styles.groupWrap}>
    {!!header && <Text accessibilityRole="header" style={[type.headline, styles.groupHeader, { color: t.text }]}>{header}</Text>}
    {rows.length > 0 && <View style={[styles.group, { backgroundColor: t.surface }]}>
      {rows.map((row, index) => <Fragment key={index}>
        {index > 0 && <View style={[styles.separator, { marginLeft: inset, backgroundColor: t.separator }]} />}
        {row}
      </Fragment>)}
    </View>}
    {!!footer && <Text style={[type.footnote, styles.groupFooter, { color: t.secondary }]}>{footer}</Text>}
  </View>;
}

/** checked: a selectable row (a checkbox to assistive technology); undefined for ordinary rows. label: replaces the
 * spoken label built from title and detail. */
export function Row({ icon, title, detail, value, onPress, disabled = false, accessory, tone, checked, label }: {
  icon?: IconName; title: string; detail?: string; value?: string | number; onPress?: () => void; disabled?: boolean; accessory?: ReactNode; tone?: 'warning'; checked?: boolean; label?: string;
}) {
  const t = useTheme();
  const content = <View style={styles.row}>
    {icon && <Ionicons name={icon} size={22} color={tone === 'warning' ? t.warning : t.accent} style={styles.rowIcon} />}
    <View style={styles.rowText}>
      <Text style={[type.body, { color: t.text }]}>{title}</Text>
      {!!detail && <Text style={[type.footnote, { color: t.secondary }]}>{detail}</Text>}
    </View>
    {value !== undefined && <Text style={[type.body, styles.value, { color: t.secondary }]}>{value}</Text>}
    {accessory ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={t.secondary} /> : null)}
  </View>;
  if (!onPress) return <View accessible accessibilityLabel={label ?? [title, detail, value].filter(item => item !== undefined && item !== '').join(', ')}>{content}</View>;
  return <Pressable accessibilityRole={checked === undefined ? 'button' : 'checkbox'} accessibilityLabel={label ?? (detail ? `${title}, ${detail}` : title)}
    accessibilityState={checked === undefined ? { disabled } : { disabled, checked }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ backgroundColor: pressed ? t.pressed : 'transparent', opacity: disabled ? 0.4 : 1 })}>{content}</Pressable>;
}

/** Status, progress and results. Fades in when the message changes so updates never jump into place. */
export function Notice({ tone, title, message, action }: { tone: Tone; title?: string; message: string; action?: { label: string; onPress: () => void } }) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const shown = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    shown.setValue(0);
    Animated.timing(shown, { toValue: 1, duration: 200, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [message, shown]);
  const fill = { info: t.surface, progress: t.surface, success: t.positiveTint, warning: t.warningTint, error: t.negativeTint }[tone];
  const icon = { info: ['information-circle', t.accent], success: ['checkmark-circle', t.positive], warning: ['warning', t.warning], error: ['alert-circle', t.negative] } as const;
  const motion = reduced ? { opacity: shown } : { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] };
  return <Animated.View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: fill }, motion]}>
    {tone === 'progress' ? <ActivityIndicator color={t.secondary} style={styles.noticeIcon} />
      : <Ionicons name={icon[tone][0]} size={22} color={icon[tone][1]} style={styles.noticeIcon} />}
    <View style={styles.noticeText}>
      {!!title && <Text style={[type.headline, { color: t.text }]}>{title}</Text>}
      <Text style={[type.body, { color: t.text }]}>{message}</Text>
      {action && <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={12} style={styles.noticeAction}>
        <Text style={[type.headline, { color: t.accent }]}>{action.label}</Text>
      </Pressable>}
    </View>
  </Animated.View>;
}

/** Back control for a top bar; label names the destination. */
export function BackButton({ label, onPress, color }: { label: string; onPress: () => void; color?: string }) {
  const t = useTheme();
  const ink = color ?? t.accent;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}
    style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}>
    <Ionicons name="chevron-back" size={26} color={ink} />
    <Text style={[type.body, { color: ink }]}>{label}</Text>
  </Pressable>;
}

/** Round icon control floating over media. */
export function MediaButton({ icon, label, onPress, disabled = false, large = false }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; large?: boolean }) {
  const t = useTheme();
  const size = large ? 64 : 48;
  return <PressScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={[styles.media, { width: size, height: size, backgroundColor: t.mediaControl, opacity: disabled ? 0.4 : 1 }]}>
    <Ionicons name={icon} size={large ? 30 : 22} color={t.onMedia} />
  </PressScale>;
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
  const t = useTheme();
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.segmented, { backgroundColor: t.raised }]}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => onChange(option.value)}
        style={[styles.segment, selected && { backgroundColor: t.dark ? t.pressed : t.surface, elevation: 1 }]}>
        <Text style={[selected ? type.headline : type.body, { color: t.text }]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

// Images already shown this session; bounded, oldest forgotten first.
const shownImages = new Set<string>();
const SHOWN_LIMIT = 2000;
const imageUri = (source: ImageProps['source']) => source && typeof source === 'object' && 'uri' in source ? source.uri : undefined;

/** Thumbnails fade in the first time they are decoded instead of popping in. One already shown this session (a list
 * that remounted, a filter or screen change) appears at once rather than blinking again. Opacity only; Android's own
 * image fade is off so the two never stack. */
export function FadeImage(props: ImageProps) {
  const uri = imageUri(props.source);
  const shown = useRef(new Animated.Value(uri && shownImages.has(uri) ? 1 : 0)).current;
  return <Animated.Image fadeDuration={0} {...props} style={[props.style, { opacity: shown }]}
    onLoad={event => {
      if (uri && !shownImages.has(uri)) {
        shownImages.add(uri);
        if (shownImages.size > SHOWN_LIMIT) shownImages.delete(shownImages.values().next().value!);
      }
      Animated.timing(shown, { toValue: 1, duration: 200, easing: EASE_OUT, useNativeDriver: true }).start(); props.onLoad?.(event);
    }} />;
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  plain: { minHeight: 48, paddingHorizontal: 12 },
  titleBlock: { gap: 4, paddingTop: 12 },
  groupWrap: { gap: 0 },
  groupHeader: { marginBottom: 8, marginHorizontal: 4 },
  groupFooter: { marginTop: 8, marginHorizontal: 4 },
  group: { borderRadius: space.radius, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth },
  row: { minHeight: space.row, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { width: 24, textAlign: 'center' },
  rowText: { flex: 1, gap: 2 },
  value: { fontVariant: ['tabular-nums'] },
  notice: { flexDirection: 'row', gap: 12, padding: 16, borderRadius: space.radius },
  noticeIcon: { marginTop: 1 },
  noticeText: { flex: 1, gap: 4 },
  noticeAction: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center', marginTop: 4 },
  back: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingRight: 8, marginLeft: -8 },
  media: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', borderRadius: 12, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
