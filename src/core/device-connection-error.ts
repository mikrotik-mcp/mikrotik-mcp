/** A failed device connection, distinct from command, permission and server errors. */
export class DeviceConnectionError extends Error {
  constructor(
    readonly device: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceConnectionError";
  }
}
