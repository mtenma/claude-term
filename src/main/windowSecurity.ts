import {app, session, shell} from 'electron'

const isWebUrl = (url: string): boolean => /^https?:\/\//.test(url)

/**
 * すべての画面に共通の制限。ファイルのドロップやリンクで、preload の API を持ったまま
 * 別のページへ移ったり、Electron の新しいウィンドウを開いたりしないようにする。
 * loadFile による初回表示は will-navigate を発火しないため、この制限の影響を受けない。
 */
export function restrictWebContents(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // リンクは画面側で openExternal に渡す。window.open で http(s) が来た場合も既定のブラウザで開く
    contents.setWindowOpenHandler(({url}) => {
      if (isWebUrl(url)) void shell.openExternal(url)
      return {action: 'deny'}
    })
  })
  void app.whenReady().then(() => {
    // 画面側で使う権限はない(コピー・ペーストはメニューのロール、通知は main から出す)
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
  })
}
