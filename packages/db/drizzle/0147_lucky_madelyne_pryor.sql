ALTER TABLE `thread_history_epochs` ADD `rewrite_epoch` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE thread_history_epochs SET rewrite_epoch = lower(hex(randomblob(16)));
--> statement-breakpoint
DROP TRIGGER timeline_history_thread_insert;
--> statement-breakpoint
DROP TRIGGER timeline_history_event_replacement;
--> statement-breakpoint
DROP TRIGGER timeline_history_event_insert;
--> statement-breakpoint
DROP TRIGGER timeline_history_event_update;
--> statement-breakpoint
DROP TRIGGER timeline_history_event_delete;
--> statement-breakpoint
CREATE TRIGGER timeline_history_thread_insert AFTER INSERT ON threads
BEGIN
  INSERT INTO thread_history_epochs (thread_id, epoch, rewrite_epoch, high_water_sequence)
  VALUES (NEW.id, lower(hex(randomblob(16))), lower(hex(randomblob(16))), 0);
END;
--> statement-breakpoint
CREATE TRIGGER timeline_history_event_replacement BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1 FROM events AS previous WHERE previous.id = NEW.id AND (
    previous.thread_id IS NOT NEW.thread_id
    OR previous.environment_id IS NOT NEW.environment_id
    OR previous.scope_kind IS NOT NEW.scope_kind
    OR previous.turn_id IS NOT NEW.turn_id
    OR previous.provider_thread_id IS NOT NEW.provider_thread_id
    OR previous.sequence IS NOT NEW.sequence
    OR previous.type IS NOT NEW.type
    OR previous.item_id IS NOT NEW.item_id
    OR previous.item_kind IS NOT NEW.item_kind
    OR previous.parent_tool_call_id IS NOT NEW.parent_tool_call_id
    OR previous.data IS NOT NEW.data
    OR previous.created_at IS NOT NEW.created_at
  )
)
BEGIN
  INSERT OR IGNORE INTO thread_history_epochs (thread_id, epoch, rewrite_epoch, high_water_sequence)
  SELECT thread_id, epoch, rewrite_epoch, high_water_sequence
  FROM thread_history_epochs
  WHERE thread_id = (SELECT thread_id FROM events WHERE id = NEW.id);
  UPDATE thread_history_epochs SET
    epoch = lower(hex(randomblob(16))),
    rewrite_epoch = CASE WHEN changes() > 0 THEN lower(hex(randomblob(16))) ELSE rewrite_epoch END
  WHERE thread_id = NEW.thread_id
    OR thread_id = (SELECT thread_id FROM events WHERE id = NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER timeline_history_event_insert AFTER INSERT ON events
BEGIN
  UPDATE thread_history_epochs SET
    epoch = CASE
      WHEN NEW.sequence <= high_water_sequence OR NEW.type = 'provider.env-resolved'
        THEN lower(hex(randomblob(16)))
      WHEN NEW.turn_id IS NULL AND NEW.parent_tool_call_id IS NULL
        AND NEW.type <> 'client/turn/requested' THEN epoch
      WHEN EXISTS (
        WITH RECURSIVE affected_turns(turn_id) AS (
          SELECT NEW.turn_id WHERE NEW.turn_id IS NOT NULL
          UNION
          SELECT parent.turn_id
          FROM events AS parent INDEXED BY events_delegating_item_lookup_idx
          WHERE NEW.parent_tool_call_id IS NOT NULL
            AND parent.thread_id = NEW.thread_id
            AND parent.item_id = NEW.parent_tool_call_id
            AND parent.item_kind IN ('toolCall', 'delegation')
            AND parent.turn_id IS NOT NULL
          UNION
          SELECT CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data, '$.target.expectedTurnId') END
          WHERE NEW.type = 'client/turn/requested'
          UNION
          SELECT accepted.turn_id
          FROM events AS accepted INDEXED BY events_thread_accepted_client_request_idx
          WHERE NEW.type = 'client/turn/requested'
            AND accepted.thread_id = NEW.thread_id
            AND accepted.type = 'turn/input/accepted'
            AND (CASE WHEN json_valid(accepted.data) THEN json_extract(accepted.data, '$.clientRequestId') END)
              = (CASE WHEN json_valid(NEW.data) THEN json_extract(NEW.data, '$.requestId') END)
          UNION
          SELECT parent.turn_id
          FROM affected_turns
          CROSS JOIN events AS child_start INDEXED BY events_thread_turn_type_item_sequence_idx
          CROSS JOIN events AS parent INDEXED BY events_delegating_item_lookup_idx
          WHERE child_start.thread_id = NEW.thread_id
            AND child_start.turn_id = affected_turns.turn_id
            AND child_start.type = 'turn/started'
            AND parent.thread_id = NEW.thread_id
            AND parent.item_id = child_start.parent_tool_call_id
            AND parent.item_kind IN ('toolCall', 'delegation')
            AND parent.turn_id IS NOT NULL
        )
        SELECT 1 FROM affected_turns
        CROSS JOIN events AS completed INDEXED BY events_thread_turn_type_item_sequence_idx
        WHERE completed.thread_id = NEW.thread_id
          AND completed.turn_id = affected_turns.turn_id
          AND completed.type = 'turn/completed'
          AND completed.id <> NEW.id
      ) THEN lower(hex(randomblob(16)))
      ELSE epoch
    END,
    rewrite_epoch = CASE
      WHEN NEW.sequence <= high_water_sequence OR NEW.type = 'provider.env-resolved'
        THEN lower(hex(randomblob(16)))
      ELSE rewrite_epoch
    END,
    high_water_sequence = MAX(high_water_sequence, NEW.sequence)
  WHERE thread_id = NEW.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER timeline_history_event_update AFTER UPDATE ON events
WHEN OLD.id IS NOT NEW.id
  OR OLD.thread_id IS NOT NEW.thread_id
  OR OLD.environment_id IS NOT NEW.environment_id
  OR OLD.scope_kind IS NOT NEW.scope_kind
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.provider_thread_id IS NOT NEW.provider_thread_id
  OR OLD.sequence IS NOT NEW.sequence
  OR OLD.type IS NOT NEW.type
  OR OLD.item_id IS NOT NEW.item_id
  OR OLD.item_kind IS NOT NEW.item_kind
  OR OLD.parent_tool_call_id IS NOT NEW.parent_tool_call_id
  OR OLD.data IS NOT NEW.data
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  UPDATE thread_history_epochs SET
    epoch = lower(hex(randomblob(16))),
    rewrite_epoch = lower(hex(randomblob(16))),
    high_water_sequence = CASE WHEN thread_id = NEW.thread_id
      THEN MAX(high_water_sequence, NEW.sequence) ELSE high_water_sequence END
  WHERE thread_id IN (OLD.thread_id, NEW.thread_id);
END;
--> statement-breakpoint
CREATE TRIGGER timeline_history_event_delete AFTER DELETE ON events
BEGIN
  UPDATE thread_history_epochs SET
    epoch = lower(hex(randomblob(16))),
    rewrite_epoch = lower(hex(randomblob(16)))
  WHERE thread_id = OLD.thread_id;
END;
