/** Whether the connection bar's card is open; the Table tab's read-only note opens it too. */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

const cardStore = createStore<{ readonly open: boolean }>(() => ({ open: false }));

export const setConnectionCard = (open: boolean) => cardStore.setState({ open });

export const openConnectionCard = () => setConnectionCard(true);

export const useConnectionCard = () => useStore(cardStore, (s) => s.open);
