export function computerProxyEnv(
  computer: {
    boxId?: string;
    token?: string;
    control?: { pipe: string; path: string; token: string } | { url: string; token: string };
  },
): NodeJS.ProcessEnv {
  return {
    OGB_BOX_ID: computer.boxId ?? "",
    OGB_BOX_TOKEN: computer.token ?? "",
    ...(computer.control
      ? "pipe" in computer.control
        ? {
            OMB_CONTROL_PIPE: computer.control.pipe,
            OMB_CONTROL_PATH: computer.control.path,
            OMB_CONTROL_TOKEN: computer.control.token,
          }
        : { OMB_CONTROL_URL: computer.control.url, OMB_CONTROL_TOKEN: computer.control.token }
      : {}),
  };
}