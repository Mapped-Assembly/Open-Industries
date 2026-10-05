import type { Workspace } from './workspace';
import type { SavedScene } from './scene-repository';

export type RoomDestination = {
  workspace: Workspace;
  scene: SavedScene | null;
  roomId: string;
  name?: string;
  selected?: number;
  message?: string;
};
export type RoomTransitionHandle = {
  requestSwitch: (label: string, prepare: () => RoomDestination | Promise<RoomDestination>) => void;
};
