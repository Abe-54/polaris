export interface DeviceCopy {
  readonly phone: string;
  readonly computer: string;
}

export const deviceCopyFor = (platform: string): DeviceCopy =>
  platform === "android"
    ? { phone: "phone", computer: "computer" }
    : { phone: "iPhone", computer: "Mac" };
