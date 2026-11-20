/**
 * Gmail災害情報LINE通知
 * Messaging API版 / 二重通知対策版 / 409修正版
 *
 * 必須スクリプトプロパティ:
 *   LINE_ACCESS_TOKEN
 *   LINE_GROUP_ID
 *   SEARCH_QUERY
 *
 * 任意:
 *   TARGET_PATTERN  例: 第[3３]分団
 *   CORPS_LABEL
 *
 * 追加した機能:
 * - GmailメッセージIDによる処理済み管理
 * - LockServiceによる同時実行防止
 * - LINEのX-Line-Retry-Keyによる重複送信防止
 * - HTTP 409の受付済みIDをレスポンスヘッダーから確認
 * - 古い災害情報の誤通知防止
 * - 古い処理記録の自動削除
 *
 * 注意:
 * 本番切替前にトリガーを停止し、
 * setGoLiveNow() を一度実行してください。
 */

const ALERT_STATE_PREFIX_ = 'ALERT_V2_';

const ALERT_DONE_LABEL_ = 'LINE災害通知_送信済';
const ALERT_PENDING_LABEL_ = 'LINE災害通知_要確認';

const ALERT_MAX_THREADS_ = 100;
const ALERT_MAX_AGE_MINUTES_ = 30;

const ALERT_STATE_RETENTION_MS_ =
  7 * 24 * 60 * 60 * 1000;

// LINEリトライキーの有効期間24時間より短く設定
const ALERT_RETRY_WINDOW_MS_ =
  23 * 60 * 60 * 1000;


/**
 * スクリプトプロパティを取得
 */
function getConfig_() {
  const props = PropertiesService.getScriptProperties();

  const lineAccessToken =
    props.getProperty('LINE_ACCESS_TOKEN');

  const lineGroupId =
    props.getProperty('LINE_GROUP_ID');

  const searchQuery =
    props.getProperty('SEARCH_QUERY');

  const targetPatternRaw =
    props.getProperty('TARGET_PATTERN');

  const corpsLabel =
    props.getProperty('CORPS_LABEL') || '対象エリア';

  if (!lineAccessToken || !lineGroupId || !searchQuery) {
    throw new Error(
      '必須スクリプトプロパティ' +
      '（LINE_ACCESS_TOKEN, LINE_GROUP_ID, SEARCH_QUERY）' +
      'が未設定です。'
    );
  }

  return {
    LINE_ACCESS_TOKEN: lineAccessToken,
    LINE_GROUP_ID: lineGroupId,
    SEARCH_QUERY: searchQuery,

    TARGET_REGEX: targetPatternRaw
      ? new RegExp(targetPatternRaw)
      : null,

    CORPS_LABEL: corpsLabel,
    MAX_THREADS: ALERT_MAX_THREADS_
  };
}


/**
 * 初回本番切替時に1回だけ実行
 *
 * 実行時刻以前のメールは新規通知対象にしない。
 */
function setGoLiveNow() {
  PropertiesService.getScriptProperties().setProperty(
    'ALERT_V2_GO_LIVE',
    String(Date.now())
  );

  console.log(
    '本番開始時刻を設定しました。' +
    'これ以前のメールは新規通知しません。'
  );
}


/**
 * メイン処理
 *
 * 1分間隔の時間駆動型トリガーから呼び出す。
 */
function mainFunction() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log(
      '前の実行が継続中のためスキップします。'
    );
    return;
  }

  try {
    const config = getConfig_();

    cleanupOldAlertStates_();

    const props =
      PropertiesService.getScriptProperties();

    const goLiveRaw =
      props.getProperty('ALERT_V2_GO_LIVE');

    if (
      !goLiveRaw ||
      !Number.isFinite(Number(goLiveRaw))
    ) {
      throw new Error(
        '初回はsetGoLiveNow()を実行して' +
        '本番開始時刻を設定してください。'
      );
    }

    const goLive = Number(goLiveRaw);

    const doneLabel =
      getOrCreateLabel_(ALERT_DONE_LABEL_);

    const pendingLabel =
      getOrCreateLabel_(ALERT_PENDING_LABEL_);

    const threads = GmailApp.search(
      config.SEARCH_QUERY,
      0,
      config.MAX_THREADS
    );

    console.log(
      `${threads.length} 件のスレッドを検査します。`
    );

    for (const thread of threads) {
      for (const message of thread.getMessages()) {

        const messageId = message.getId();
        const messageDate =
          message.getDate().getTime();

        // 本番開始前のメールは対象外
        if (messageDate < goLive) {
          continue;
        }

        // メッセージIDから処理状態を取得
        const stateKey =
          stateKeyFor_(messageId);

        const stateRaw =
          props.getProperty(stateKey);

        const state = stateRaw
          ? JSON.parse(stateRaw)
          : null;

        // 送信済み・恒久エラーは再送しない
        if (
          state &&
          (
            state.status === 'done' ||
            state.status === 'permanent'
          )
        ) {
          continue;
        }

        // 既存運用でスター済みのメールは尊重する
        if (message.isStarred() && !state) {
          continue;
        }

        const body = message.getPlainBody();
        const subject = message.getSubject();

        // 対象分団の判定
        const isTargetCorps =
          config.TARGET_REGEX
            ? new RegExp(
                config.TARGET_REGEX.source,
                config.TARGET_REGEX.flags.replace(
                  /[gy]/g,
                  ''
                )
              ).test(body)
            : true;

        // 災害発生の判定
        const isOccurred =
          (
            subject.includes('発生') ||
            body.includes('発生')
          ) &&
          !subject.includes('終了') &&
          !subject.includes('解除');

        // 対象外メール
        if (!isTargetCorps || !isOccurred) {
          message.star();
          continue;
        }

        // 古いメールの誤通知防止
        const ageMinutes =
          (Date.now() - messageDate) / 60000;

        if (
          !state &&
          ageMinutes > ALERT_MAX_AGE_MINUTES_
        ) {
          console.error(
            '古い未処理災害情報を保留: ' +
            `id=${messageId}, ` +
            `age=${Math.round(ageMinutes)}分, ` +
            `subject=${subject}`
          );

          thread.addLabel(pendingLabel);
          continue;
        }

        // LINE通知本文
        const lineMessage =
          `【🚒 災害発生通知（${config.CORPS_LABEL}）】\n` +
          `受信日時: ${Utilities.formatDate(
            message.getDate(),
            'JST',
            'yyyy/MM/dd HH:mm'
          )}\n` +
          `件名: ${subject}\n` +
          `--------------------\n` +
          `${body.trim()}`;

        // LINEテキストメッセージの文字数制限
        if (lineMessage.length > 5000) {
          console.error(
            `LINE文字数上限超過: id=${messageId}`
          );

          thread.addLabel(pendingLabel);
          continue;
        }

        // 初回送信時だけリトライキーを作成
        const attempt = state || {
          status: 'pending',
          retryKey: Utilities.getUuid(),
          createdAt: Date.now()
        };

        // LINEへの送信より先に永続保存
        if (!state) {
          props.setProperty(
            stateKey,
            JSON.stringify(attempt)
          );
        }

        // リトライキーの期限超過
        if (
          Date.now() - attempt.createdAt >
          ALERT_RETRY_WINDOW_MS_
        ) {
          console.error(
            '再試行期限超過。自動再送せず保留: ' +
            `id=${messageId}`
          );

          thread.addLabel(pendingLabel);
          continue;
        }

        // LINEに送信
        const result = sendLineMessage(
          lineMessage,
          config,
          attempt.retryKey
        );

        if (result === 'accepted') {

          // 送信受付済みとして保存
          props.setProperty(
            stateKey,
            JSON.stringify({
              status: 'done',
              completedAt: Date.now()
            })
          );

          message.star();
          thread.addLabel(doneLabel);

          console.log(
            'LINE送信受付済み: ' +
            `messageId=${messageId}, ` +
            `subject=${subject}`
          );

        } else if (result === 'permanent') {

          console.error(
            'LINE送信に恒久エラー: ' +
            `id=${messageId}`
          );

          props.setProperty(
            stateKey,
            JSON.stringify({
              status: 'permanent',
              completedAt: Date.now()
            })
          );

          thread.addLabel(pendingLabel);

        } else {

          // transient:
          // 同じリトライキーを使って次回再試行
          console.warn(
            'LINE送信結果が未確定。' +
            '次回同じretry keyで再試行: ' +
            `id=${messageId}`
          );
        }
      }
    }

  } catch (e) {

    console.error(
      'エラーが発生しました: ' +
      (e.stack || e)
    );

    // トリガー失敗通知を有効にする
    throw e;

  } finally {

    lock.releaseLock();
  }
}


/**
 * 古い処理状態を削除
 */
function cleanupOldAlertStates_() {
  const props =
    PropertiesService.getScriptProperties();

  const all = props.getProperties();
  const now = Date.now();

  for (const key in all) {

    if (!key.startsWith(ALERT_STATE_PREFIX_)) {
      continue;
    }

    try {
      const state = JSON.parse(all[key]);

      const timestamp =
        state.completedAt || state.createdAt;

      if (
        timestamp &&
        now - timestamp > ALERT_STATE_RETENTION_MS_
      ) {
        props.deleteProperty(key);
      }

    } catch (e) {
      console.warn(
        '不正な処理記録を検出: ' + key
      );
    }
  }
}


/**
 * GmailメッセージIDから保存用キーを生成
 */
function stateKeyFor_(messageId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    messageId
  );

  const hex = digest.map(
    b => ('0' + (b & 255).toString(16)).slice(-2)
  ).join('');

  return ALERT_STATE_PREFIX_ + hex.slice(0, 32);
}


/**
 * Gmailラベルを取得、なければ作成
 */
function getOrCreateLabel_(name) {
  return (
    GmailApp.getUserLabelByName(name) ||
    GmailApp.createLabel(name)
  );
}


/**
 * LINE Messaging APIへのPush送信
 *
 * @param {string} text LINE通知本文
 * @param {Object} config 設定
 * @param {string} retryKey リトライキー
 *
 * @returns {'accepted'|'transient'|'permanent'}
 *
 * HTTP 200:
 *   新規送信を受理
 *
 * HTTP 409 + x-line-accepted-request-id:
 *   同一リトライキーによる既受付
 *
 * HTTP 409 + 受付済みIDなし:
 *   状態不明として同一キーで再試行
 */
function sendLineMessage(text, config, retryKey) {
  const url =
    'https://api.line.me/v2/bot/message/push';

  const payload = {
    to: config.LINE_GROUP_ID,
    messages: [
      {
        type: 'text',
        text: text
      }
    ]
  };

  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        'Bearer ' + config.LINE_ACCESS_TOKEN,
      'X-Line-Retry-Key': retryKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(
      url,
      options
    );

    const code = response.getResponseCode();
    const responseText =
      response.getContentText();

    // 200: 新規送信受付済み
    if (code === 200) {
      console.log(
        'LINEメッセージ送信受付成功: HTTP 200'
      );
      return 'accepted';
    }

    // 409: 同一リトライキーの既受付を確認
    if (code === 409) {

      // レスポンス本文ではなくヘッダーを調べる
      const headers = response.getAllHeaders();

      // HTTPヘッダー名は大文字小文字を区別しない
      const headerName = Object.keys(headers).find(
        name =>
          name.toLowerCase() ===
          'x-line-accepted-request-id'
      );

      const headerValue = headerName
        ? headers[headerName]
        : null;

      // GASでは複数値が配列として返る場合がある
      const acceptedRequestId =
        Array.isArray(headerValue)
          ? headerValue[0]
          : headerValue;

      if (
        acceptedRequestId &&
        String(acceptedRequestId).trim()
      ) {
        console.log(
          'LINE送信は既に受付済み: ' +
          `acceptedRequestId=${acceptedRequestId}`
        );

        return 'accepted';
      }

      // 409なのに受付済みIDがない場合
      // 恒久エラー扱いせず、同じキーで再確認する
      console.error(
        'LINE HTTP 409: ' +
        '受付済みリクエストIDを確認できません。' +
        responseText
      );

      return 'transient';
    }

    console.error(
      `LINE送信失敗: HTTP ${code} - ${responseText}`
    );

    // タイムアウト相当・一時的なサーバー障害
    if (
      code === 408 ||
      code === 429 ||
      code >= 500
    ) {
      return 'transient';
    }

    // その他の4xxなど
    return 'permanent';

  } catch (e) {

    // 通信例外では送信済みかどうか不明
    console.error(
      'LINE送信結果不明: ' + e
    );

    return 'transient';
  }
}