/**
 * スクリプト名: 既読メール検出デバッグツール（公開用テンプレート）
 * 概要: スクリプト プロパティに設定した条件でメールが取得できているかログで確認します。
 */

function debugCheck() {
  try {
    const props = PropertiesService.getScriptProperties();
    const searchQuery = props.getProperty('DEBUG_SEARCH_QUERY') || props.getProperty('SEARCH_QUERY');
    const targetPatternRaw = props.getProperty('TARGET_PATTERN');
    const targetPattern = targetPatternRaw ? new RegExp(targetPatternRaw) : null;
    const maxThreads = 10;

    if (!searchQuery) {
      throw new Error('スクリプト プロパティ（SEARCH_QUERY または DEBUG_SEARCH_QUERY）が未設定です。');
    }

    const threads = GmailApp.search(searchQuery, 0, maxThreads);
    console.log(`ヒットしたスレッド数: ${threads.length} 件`);

    if (threads.length === 0) {
      console.log('対象条件に一致するメールが見つかりませんでした。');
      return;
    }

    threads.forEach((thread, index) => {
      const messages = thread.getMessages();
      messages.forEach((msg) => {
        const body = msg.getPlainBody();
        const isMatched = targetPattern ? targetPattern.test(body) : true;

        console.log(`[スレッド${index + 1}] 件名: ${msg.getSubject()}`);
        console.log(` - 受信日時: ${msg.getDate()}`);
        console.log(` - 未読状態: ${msg.isUnread()}`);
        if (targetPattern) {
          console.log(` - パターン一致判定: ${isMatched ? '一致あり' : 'なし'}`);
        }
      });
    });
  } catch (e) {
    console.error('エラー発生: ' + e.stack);
  }
}