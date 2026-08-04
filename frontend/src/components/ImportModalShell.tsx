import { Group, Modal, Text, Tooltip } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { ReactNode } from "react";

import styles from "./ImportModalShell.module.css";

/** Width shared by every import step so advancing never resizes the dialog. */
export const IMPORT_MODAL_WIDTH = "78rem";

/**
 * The common shell for the three import steps.
 *
 * The steps were built incrementally and had drifted into three different
 * layouts: actions in a footer, actions inside the modal title, and actions in
 * a toolbar under the tabs. Worse, notices and progress were injected *above*
 * the panes, so the region the user was reading moved down by as much as 230 px
 * as state changed.
 *
 * Everything here exists to keep that region still: one fixed geometry, a
 * single scrolling work area, and footer slots that occupy layout whether or
 * not they currently render anything.
 */
export function ImportModalShell({
  opened,
  onClose,
  title,
  step,
  totalSteps = 3,
  titleInfo,
  notice,
  progress,
  actions,
  closeDisabled = false,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  step?: number;
  totalSteps?: number;
  /** Standing explanation, as an info affordance rather than a paragraph. */
  titleInfo?: string;
  /** Warnings and conflicts. Rendered in a reserved footer slot. */
  notice?: ReactNode;
  /** Progress reporting. Rendered in a reserved footer slot. */
  progress?: ReactNode;
  /** Footer buttons. Wrap trailing controls in `ImportModalPrimaryActions`. */
  actions?: ReactNode;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      opened={opened}
      onClose={closeDisabled ? () => undefined : onClose}
      // A plain string keeps the accessible name to the step itself. Step 2
      // previously nested its buttons here, so screen readers announced
      // "Choose files to importBackContinue with 12 files".
      title={
        <Group gap="xs" wrap="nowrap">
          <Text size="lg" fw={500}>
            {title}
          </Text>
          {step !== undefined && (
            <Text size="sm" c="dimmed">
              Step {step} of {totalSteps}
            </Text>
          )}
          {titleInfo && (
            <Tooltip label={titleInfo} multiline w={320} withArrow>
              <IconInfoCircle
                size={16}
                aria-label={titleInfo}
                tabIndex={0}
                style={{ cursor: "help", opacity: 0.7 }}
              />
            </Tooltip>
          )}
        </Group>
      }
      size={IMPORT_MODAL_WIDTH}
      classNames={{ content: styles.content, body: styles.body }}
    >
      <div className={styles.work}>{children}</div>
      <div className={styles.footer}>
        {notice !== undefined && notice !== null && <div className={styles.slot}>{notice}</div>}
        {progress !== undefined && progress !== null && <div className={styles.slot}>{progress}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </Modal>
  );
}

/** Right-aligned trailing group: secondary actions left, primary action last. */
export function ImportModalPrimaryActions({ children }: { children: ReactNode }) {
  return <div className={styles.actionsEnd}>{children}</div>;
}

/** Inline info affordance, replacing a standing explanatory sentence. */
export function ImportInfoHint({ label }: { label: string }) {
  return (
    <Tooltip label={label} multiline w={320} withArrow>
      <IconInfoCircle
        size={15}
        aria-label={label}
        tabIndex={0}
        style={{ cursor: "help", opacity: 0.7, flex: "none" }}
      />
    </Tooltip>
  );
}
