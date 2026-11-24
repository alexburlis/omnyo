import { atom, type SetStateAction, type WritableAtom } from "jotai";
import {
  getUiPreferenceDefault,
  type UiPreferenceKey,
  type UiPreferenceValue,
} from "@omnyo/domain";
import {
  registerSyncedUiPreference,
  importUiPreferenceValueV1,
  scheduleUiPreferenceWrite,
} from "./ui-preferences-sync";

export type SyncedPreferenceAtom<Key extends UiPreferenceKey> = WritableAtom<
  UiPreferenceValue<Key>,
  [SetStateAction<UiPreferenceValue<Key>>],
  void
>;

export function createSyncedPreferenceAtom<Key extends UiPreferenceKey>(
  key: Key,
): SyncedPreferenceAtom<Key> {
  const valueAtom = atom<UiPreferenceValue<Key>>(getUiPreferenceDefault(key));
  registerSyncedUiPreference(key, { valueAtom });

  return atom(
    (get) => get(valueAtom),
    (get, set, update: SetStateAction<UiPreferenceValue<Key>>) => {
      const previous = get(valueAtom);

      const projected =
        typeof update === "function"
          ? (value: UiPreferenceValue<Key>) =>
              importUiPreferenceValueV1(key, update(value))
          : importUiPreferenceValueV1(key, update);

      set(
        valueAtom,
        typeof projected === "function" ? projected(previous) : projected,
      );
      scheduleUiPreferenceWrite(key, projected);
    },
  );
}
