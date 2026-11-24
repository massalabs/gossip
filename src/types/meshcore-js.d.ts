// meshcore.js (@liamcottle/meshcore.js, MIT) ships plain JavaScript. These
// declarations cover the parts Gossip uses.
declare module '@liamcottle/meshcore.js/src/connection/connection.js' {
  export default class Connection {
    on(event: string | number, callback: (data: unknown) => void): void;
    off(event: string | number, callback: (data: unknown) => void): void;
    emit(event: string | number, data?: unknown): void;
    onConnected(): Promise<void>;
    onDisconnected(): void;
    onFrameReceived(frame: Uint8Array): void;
    close(): Promise<void>;
    sendToRadioFrame(data: Uint8Array): Promise<void>;
    getChannel(channelIdx: number): Promise<{
      channelIdx: number;
      name: string;
      secret: Uint8Array;
    }>;
    setChannel(
      channelIdx: number,
      name: string,
      secret: Uint8Array
    ): Promise<void>;
    sendChannelData(
      channelIdx: number,
      pathLen: number,
      path: Uint8Array,
      dataType: number,
      payload: Uint8Array
    ): Promise<void>;
    getWaitingMessages(): Promise<unknown[]>;
  }
}

declare module '@liamcottle/meshcore.js/src/constants.js' {
  const Constants: {
    Ble: {
      ServiceUuid: string;
      CharacteristicUuidRx: string;
      CharacteristicUuidTx: string;
    };
    ResponseCodes: { ChannelDataRecv: number; ChannelInfo: number };
    PushCodes: { MsgWaiting: number };
  };
  export default Constants;
}
