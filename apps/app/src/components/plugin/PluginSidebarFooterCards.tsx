import { Fragment, memo, type Ref } from "react";
import type { ExperimentalSidebarFooterCardProps } from "@omnyo/plugin-sdk";
import {
  usePluginSlots,
  type ExperimentalSidebarFooterCardSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";
import { ResourcesRailWidget } from "@/components/sidebar/ResourcesRailWidget";

type CardPlacement = NonNullable<
  ExperimentalSidebarFooterCardProps["experimental_placement"]
>;

export type SidebarFooterCardPlacement = "sidebar" | "footer" | "status";

const PluginSidebarFooterCard = memo(function PluginSidebarFooterCard({
  slot,
  placement,
}: {
  slot: ExperimentalSidebarFooterCardSlot;
  placement: CardPlacement;
}) {
  const Component = slot.component;

  return (
    <PluginSlotMount
      pluginId={slot.pluginId}
      slotKind="sidebarFooterCard"
      slotId={slot.id}
      crashFallback={null}
    >
      <Component experimental_placement={placement} />
    </PluginSlotMount>
  );
});

function isUsageCard(slot: ExperimentalSidebarFooterCardSlot): boolean {
  return slot.pluginId === "omnyo--account-usage" && slot.id === "usage";
}

function isResourcesCard(slot: ExperimentalSidebarFooterCardSlot): boolean {
  return slot.pluginId === "resources";
}

function isSidebarFilterCard(slot: ExperimentalSidebarFooterCardSlot): boolean {
  return slot.pluginId === "chat-topics" && slot.id === "tag-filter";
}

function otherCards(
  cards: readonly ExperimentalSidebarFooterCardSlot[],
): ExperimentalSidebarFooterCardSlot[] {
  return cards.filter(
    (slot) =>
      !isUsageCard(slot) &&
      !isResourcesCard(slot) &&
      !isSidebarFilterCard(slot),
  );
}

function cardsForPlacement(
  cards: readonly ExperimentalSidebarFooterCardSlot[],
  placement: SidebarFooterCardPlacement,
): ExperimentalSidebarFooterCardSlot[] {
  if (placement === "sidebar") return otherCards(cards);

  return [...cards.filter(isUsageCard), ...cards.filter(isResourcesCard)];
}

const PLACEMENT_CLASS: Record<SidebarFooterCardPlacement, string> = {
  sidebar: "contents",
  footer: "flex h-full shrink-0 items-center gap-4",
  status: "flex h-full items-center gap-2.5",
};

function FooterDivider() {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="h-3.5 w-px shrink-0 bg-border-seam"
    />
  );
}

export function PluginSidebarFooterCards({
  placement = "sidebar",
  ref,
}: {
  placement?: SidebarFooterCardPlacement;
  ref?: Ref<HTMLDivElement>;
}) {
  const { sidebarFooterCards, navPanels } = usePluginSlots();

  const nativeResources =
    placement !== "sidebar" &&
    !sidebarFooterCards.some(isResourcesCard) &&
    navPanels.some(
      (slot) => slot.pluginId === "resources" && slot.id === "resources",
    );

  const cards = cardsForPlacement(sidebarFooterCards, placement);

  if (cards.length === 0 && !nativeResources) return null;

  const cardPlacement: CardPlacement =
    placement === "status" ? "footer" : placement;

  const divides = placement !== "sidebar";

  return (
    <div
      ref={ref}
      data-omnyo-plugin-sidebar-footer-cards=""
      data-placement={placement}
      role={placement === "sidebar" ? undefined : "group"}
      aria-label={
        placement === "sidebar" ? undefined : "Live usage and resources"
      }
      className={PLACEMENT_CLASS[placement]}
    >
      {cards.map((slot, index) => (
        <Fragment key={`${slot.pluginId}/${slot.id}/${slot.generation}`}>
          {divides && index > 0 ? <FooterDivider /> : null}
          <PluginSidebarFooterCard slot={slot} placement={cardPlacement} />
        </Fragment>
      ))}
      {nativeResources ? (
        <>
          {divides && cards.length > 0 ? <FooterDivider /> : null}
          <ResourcesRailWidget />
        </>
      ) : null}
    </div>
  );
}

export function PluginFooterCenterCards() {
  const { sidebarFooterCards } = usePluginSlots();

  return otherCards(sidebarFooterCards).map((slot, index) => (
    <Fragment key={`${slot.pluginId}/${slot.id}/${slot.generation}`}>
      {index > 0 ? <FooterDivider /> : null}
      <PluginSidebarFooterCard slot={slot} placement="footer" />
    </Fragment>
  ));
}

export function PluginFooterSidebarCards() {
  const { sidebarFooterCards } = usePluginSlots();

  return sidebarFooterCards
    .filter(isSidebarFilterCard)
    .map((slot) => (
      <PluginSidebarFooterCard
        key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
        slot={slot}
        placement="footer"
      />
    ));
}
