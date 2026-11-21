import { ActionIcon, Paper, Text, Transition } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconInfoCircle, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

export function ContinuedModeNotice({ channel }: { channel: string }) {
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const reducedMotion = useReducedMotion();
  const noticeId = useId();
  const infoButton = useRef<HTMLButtonElement>(null);
  const openedWithKeyboard = useRef(false);
  const focusCloseButton = useCallback((button: HTMLButtonElement | null) => {
    if (button && openedWithKeyboard.current) {
      openedWithKeyboard.current = false;
      button.focus();
    }
  }, []);

  useEffect(() => setVisible(true), []);
  useEffect(() => {
    if (!visible || hovered || focusWithin) return;
    const timer = window.setTimeout(() => setVisible(false), 6000);
    return () => window.clearTimeout(timer);
  }, [visible, hovered, focusWithin]);

  function dismiss() {
    setVisible(false);
    setHovered(false);
    setFocusWithin(false);
    openedWithKeyboard.current = false;
    infoButton.current?.focus();
  }

  return (
    <>
      <ActionIcon ref={infoButton} className="continued-mode-info" size="sm" variant="subtle" color="teal"
        aria-label="Why one continued cell was selected" title="Why one continued cell was selected"
        aria-expanded={visible} aria-controls={visible ? noticeId : undefined}
        data-mantine-stop-propagation={visible}
        onKeyDown={(event) => {
          if (event.key === "Escape" && visible) {
            event.stopPropagation();
            dismiss();
          }
        }}
        onClick={(event) => {
          if (visible) dismiss();
          else {
            openedWithKeyboard.current = event.detail === 0;
            setVisible(true);
          }
        }}>
        <IconInfoCircle size={16} />
      </ActionIcon>
      <Transition mounted={visible} transition="fade" duration={reducedMotion ? 0 : 180}>
        {(style) => (
          <Paper id={noticeId} className="continued-mode-notice" withBorder shadow="md"
            radius="md" py="xs" pl="sm" pr={36} style={style}
            onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
            onFocusCapture={() => setFocusWithin(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                dismiss();
              }
            }}>
            <Text role="status" size="sm">I've autoselected this because these files come from the same run on channel {channel}, and each recording starts shortly after the previous one ends.</Text>
            <ActionIcon ref={focusCloseButton} className="continued-mode-notice-close" size="sm"
              variant="subtle" color="gray" aria-label="Close explanation"
              data-mantine-stop-propagation="true" onClick={dismiss}>
              <IconX size={14} />
            </ActionIcon>
          </Paper>
        )}
      </Transition>
    </>
  );
}
