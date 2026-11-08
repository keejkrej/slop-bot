export {};

declare global {
  interface Window {
    __electrobunSendToHost?: (payload: unknown) => void;
  }
}
