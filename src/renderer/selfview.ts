// A small mirror of the camera that only the person sees while recording (the window is kept out of the recording).
const device = new URLSearchParams(location.search).get('device') ?? 'default'
void navigator.mediaDevices
  .getUserMedia({ video: { deviceId: device && device !== 'default' ? { exact: device } : undefined, width: { ideal: 640 }, height: { ideal: 360 } }, audio: false })
  .then((stream) => {
    const v = document.getElementById('v') as HTMLVideoElement
    v.srcObject = stream
    void v.play().catch(() => undefined)
  })
  .catch(() => undefined)
