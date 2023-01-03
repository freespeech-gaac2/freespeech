import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import ImmutablePropTypes from 'react-immutable-proptypes';
import { me } from 'mastodon/initial_state';
import Button from 'mastodon/components/button';
import Icon from 'mastodon/components/icon';
import ChatArea from '../components/chatarea';
import { firebaseDb, ref, onValue, serverTimestamp } from '../components/firebaseapp';
import { setTitle, updateRoom, getPushStreamUrl } from 'mastodon/actions/livechat';
import { FormattedDate } from 'react-intl';
import UploadButtonContainer from '../containers/upload_button_container';
import UploadFormContainer from '../containers/upload_form_container';
import { showAlert } from 'mastodon/actions/alerts';
import {QRCodeSVG} from 'qrcode.react';
import Hls from 'hls.js';

const mapStateToProps = state => {
  return {
    myAccount: state.getIn(['accounts', me]),
    statusId: state.getIn(['livechat', 'statusId'], null),
    is_uploading: state.getIn(['livechat', 'is_uploading']),
  };
};

export default @connect(mapStateToProps)
class LivechatRTMP extends React.Component {

  static contextTypes = {
    router: PropTypes.object,
  };

  static propTypes = {
    myAccount: ImmutablePropTypes.map.isRequired,
    statusId: PropTypes.string,
    is_uploading: PropTypes.bool.isRequired,
    params: PropTypes.object.isRequired,
    dispatch: PropTypes.func.isRequired,
  };

  constructor(props) {
    super(props);
    this.state = {
      title: '', // 入力フォームの値
      description: '', // 入力フォームの値
      thumbnail: null, // サムネイルURL
      thumbnail_id: null, // サムネイルのmedia_attachments ID
      title_on_firebase: '', // firebaseに保存されているタイトル
      description_on_firebase: '', // firebaseに保存されている説明文
      webrtc_push_url: null,
      published_at: null,
      ping_at: null,
      end_at: null,
      m3u8_pull_url: null,
      m3u8_supported: null,
      rtmp_push_url: null,
      player_initialized: false,
      watching: 0, // 現在の視聴者数
      watched: 0, // 過去を含むユニーク視聴者数
    };
  }

  componentDidMount = () => {
    this.initFirebase();
    window.addEventListener('beforeunload', this.beforeunloadpage);
    this.props.dispatch(getPushStreamUrl(this.props.params.roomId, (data)=>{
      this.setState({ rtmp_push_url: data.push_stream_url, m3u8_pull_url: data.m3u8_pull_url });
      this.hlsFetchCount=0;
      this.hlsFetchOKCount = 0;
      this.checkHlsAvailable();
    }));
  }

  componentDidUpdate() {
    if (!this.state.end_at) {
      window.history.pushState(null, document.title, window.location.href);
      window.addEventListener('popstate', this.onpopstate);
    }
  }

  componentWillUnmount = () => {
    this.onValueUnsubscribe?.();
    this.onValueUnsubscribe = null;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.hlsCheckInterval) {
      clearInterval(this.hlsCheckInterval);
      this.hlsCheckInterval = null;
    }
    window.removeEventListener('beforeunload', this.beforeunloadpage);
    if (Hls.isSupported() && this.hls) {
      this.hls.destroy();
    }
  }

  beforeunloadpage = e => {
    if (!this.state.end_at) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  onpopstate = () => {
    if (!this.state.end_at) {
      window.history.pushState(null, document.title, window.location.href);
    }
  };

  initFirebase = () => {
    this.roomRef = ref(firebaseDb, `room/${this.props.params.roomId}`);

    this.onValueUnsubscribe = onValue(this.roomRef, (snapshot) => {
      const m = snapshot.val();
      // FIXME データが存在しないときと、ルーム作成者ではないときは、別ページにリダイレクト
      if (m) {
        const title = m.title ?? '';
        const description = m.description ?? '';
        const thumbnail = m.thumbnail ?? null;
        const thumbnail_id = m.thumbnail_id ?? null;
        const published_at = m.published_at;
        const ping_at = m.ping_at;
        const end_at = m.end_at;
        const status_id = m.status_id ?? null;
        const m3u8_pull_url = m.m3u8_pull_url ?? null;
        const watching = m.watching ?? 0;
        const watched = m.watched ?? 0;
        const updateStates = { title_on_firebase: title, description_on_firebase: description, m3u8_pull_url, published_at, ping_at, end_at, watching, watched };
        if(this.state.title_on_firebase !== title){
          this.titleDom.value = title;
          updateStates.title = title;
        }
        if(this.state.description_on_firebase !== description){
          this.descriptionDom.value = description;
          updateStates.description = description;
        }
        if(!this.props.is_uploading){
          updateStates.thumbnail_id = thumbnail_id;
          updateStates.thumbnail = thumbnail;
          this.props.dispatch(setTitle(this.props.params.roomId, title, description, thumbnail, thumbnail_id, status_id)); // firebase to redux store
        }

        if (this.state.player_initialized && published_at && end_at) {
          queueMicrotask(() => {
            this.stopHlsClient();
          });
        }

        this.setState(updateStates);
      }
      queueMicrotask(() => {
        // 初回のデータが来るまでは編集不可
        // 入力内容に応じて高さを自動調整
        this.titleDom.disabled = false;
        this.titleDom.style.height = 'auto';
        this.titleDom.style.height = this.titleDom.scrollHeight + 'px';
        this.descriptionDom.disabled = false;
        this.descriptionDom.style.height = 'auto';
        this.descriptionDom.style.height = this.descriptionDom.scrollHeight + 'px';
      });
    });
    if(!this.pingInterval) {
      this.pingInterval = setInterval(() => {
        this.props.dispatch(updateRoom(this.props.params.roomId, { ping_at: serverTimestamp() }));
      }, 10 * 1000);
    }
  }

  checkHlsAvailable = () => {
    if (this.hlsFetching) {
      return;
    }
    this.hlsFetching = true;
    this.hlsFetchCount++;
    fetch(this.state.m3u8_pull_url)
    .then(
      (result) => {
        this.hlsFetching = false;
        if(result.status==200){ // 最初の1回目でエラーなく成功した場合は即再生開始
          if(this.hlsFetchCount==1){
            this.initHlsClient(this.state.m3u8_pull_url);
            return;
          }
          this.hlsFetchOKCount++;
          if(this.hlsFetchOKCount>=3){ // エラー後に成功した場合は複数回チェックしてから再生開始
            if(this.hlsCheckInterval){
              clearInterval(this.hlsCheckInterval);
              this.hlsCheckInterval = null;
            }
            this.initHlsClient(this.state.m3u8_pull_url);
          }
        }else{
          this.hlsFetchOKCount = 0;
          if(!this.hlsCheckInterval){
            this.hlsCheckInterval = setInterval(() => {
              this.checkHlsAvailable();
            }, 5 * 1000);
          }
        }
      },
      (error) => {
        this.hlsFetching = false;
        console.log("hlsCheckError", error);
      }
    )
  }
  
  initHlsClient = (m3u8_pull_url) => {
    if (this.videoDom) {
      if (Hls.isSupported()) {
        this.hls = new Hls();
        this.hls.on(Hls.Events.ERROR, function (event, data) {
          console.error("hls.js error", data);
        });
        this.hls.loadSource(m3u8_pull_url);
        this.hls.attachMedia(this.videoDom);
        this.setState({ m3u8_supported: true, player_initialized: true });
      } else {
        this.setState({ m3u8_supported: false });
      }
    }
  }

  stopHlsClient = () => {
    if (this.videoDom) {
      if (Hls.isSupported()) {
        this.hls.destroy();
        this.setState({ player_initialized: false });
      }
    }
  }

  onReloadHlsClient = () => {
    if(this.hls){
      this.stopHlsClient();
      this.initHlsClient(this.state.m3u8_pull_url);
    }
  }

  setTitleDom = (c) => {
    this.titleDom = c;
  }

  setDescriptionDom = (c) => {
    this.descriptionDom = c;
  }

  setVideoDom = (c) => {
    this.videoDom = c;
  }

  onTextChange = (e) => {
    if (e.target.name === 'title' || e.target.name === 'description') {
      this.setState({ [e.target.name]: e.target.value });
      queueMicrotask(() => {
        // 入力内容に応じて高さを自動調整
        this.titleDom.style.height = 'auto';
        this.titleDom.style.height = this.titleDom.scrollHeight + 'px';
        this.descriptionDom.style.height = 'auto';
        this.descriptionDom.style.height = this.descriptionDom.scrollHeight + 'px';
      });
    }
  }

  // タイトルは改行禁止
  // FIXME タイトルにコピペで改行が入力できるバグ
  // この関数を修正する場合は、日本語入力の確定エンターキーの動作確認を必ずすること
  onKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  }

  // 保存ボタンクリックイベント firebaseにタイトルと説明文を保存 すでに公開済みの場合はトゥートも更新
  handleSaveClick = async () => {
    const param = {};
    if(this.state.title !== this.state.title_on_firebase){
      param.title = this.state.title;
    }
    if(this.state.description !== this.state.description_on_firebase){
      param.description = this.state.description;
    }
    this.props.dispatch(updateRoom(this.props.params.roomId, param));
  }

  onScreenshot = () => {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var w = this.videoDom.offsetWidth;
    var h = this.videoDom.offsetHeight;
    canvas.setAttribute('width', w);
    canvas.setAttribute('height', h);
    ctx.drawImage(this.videoDom, 0, 0, w, h);
    canvas.toBlob(function(blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'screenshot.' + new Date().toLocaleString() + '.jpg';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/jpeg', 0.95);
  }

  // タイトル、詳細文が修正されている場合true
  isTitleModified = () => {
    let modified = !(this.state.title === this.state.title_on_firebase && this.state.description === this.state.description_on_firebase);
    return modified
  }

  // 公開ボタンクリックイベント // FIXME 2度押し対策
  onPublishStreamStart = async () => {
    if(this.isTitleModified()){
      this.handleSaveClick();
    }
    this.props.dispatch(getPushStreamUrl(this.props.params.roomId, this.onPublishStreamSuccess));
  }

  onPublishStreamSuccess = async (data) => {
    try {
      if (!this.state.published_at) {
        this.props.dispatch(updateRoom(this.props.params.roomId, { published_at: Date.now() }));
      }
      window.addEventListener('beforeunload', this.beforeunloadpage);
      window.addEventListener('popstate', this.onpopstate);
    } catch (error) {
      this.props.dispatch(showAlert(error.errorCode, error.message));
    }
  }

  // 終了ボタンクリック ライブ停止 // FIXME 2度押し対策
  onPublishStreamStop = async () => {
    this.props.dispatch(updateRoom(this.props.params.roomId, { end_at: Date.now() }));
  }

  onBackToHome = () => {
    this.context.router.history.push('/home');
  }

  render() {
    const { roomId } = this.props.params;
    let canStartPublishStream = this.state.title.length > 0 && this.state.description.length > 0 && this.state.player_initialized && this.state.thumbnail?.length > 0;
    return (
      <div className='livechat'>
        <div className='info'>
          <div className='player'><video className='video' ref={this.setVideoDom} controls autoPlay muted playsInline /></div>
          {(!this.state.player_initialized) && <div>配信待ち</div>}
          <div className='row marTopSmall'>
            {this.state.player_initialized && 
            <>
            <Button onClick={this.onScreenshot} className='buttonSmall marRightSmall'><Icon id='camera' />&nbsp;スクショ保存</Button>
            <Button onClick={this.onReloadHlsClient} className='buttonSmall marRightSmall'><Icon id='refresh' />&nbsp;プレイヤー再読込</Button>
            </>}
          </div>
          <div className='separator' />
          <div className='marTopSmall row'>
            <div>
              <div className='row'><label className='label'>ライブ配信開始日:</label> {this.state.published_at ? (<FormattedDate value={new Date(this.state.published_at)} hour12={false} year='numeric' month='short' day='2-digit' hour='2-digit' minute='2-digit' />) : (<>未配信</>)}</div>
              {this.state.published_at && <div className='row'><label className='label'>ライブ配信終了日:</label> {this.state.end_at ? (<FormattedDate value={new Date(this.state.end_at)} hour12={false} year='numeric' month='short' day='2-digit' hour='2-digit' minute='2-digit' />) : (<>未終了</>)}</div>}
            </div>
            <div className='spacer' />
            <div>
              <div className='row'><label className='label'>現在の視聴者数:</label> {this.state.watching}</div>
              <div className='row'><label className='label'>累計の視聴者数:</label> {this.state.watched}</div>
            </div>
          </div>
          {this.state.rtmp_push_url && (<>
            <div className='separator' />
            <div className='marTopSmall row' style={{maxWidth:"50vw"}}>
              <div className='marRightSmall'><QRCodeSVG value={this.state.rtmp_push_url} /></div>
              <div>
                <div>GC2PubアプリでこちらのQRコードを読み込んで配信を開始してください。</div>
                <div style={{wordBreak: "break-all"}}>{this.state.rtmp_push_url}</div>
              </div>
            </div>
          </>)}
          <div className='separator' />
          <div className='simple_form marTopSmall'>
            <label htmlFor='title'>タイトル</label>
            <div className='label_input__wrapper'>
              <textarea id='title' rows='1' name='title' placeholder='タイトルを入力...' className='text optional textareaSmall' ref={this.setTitleDom} onChange={this.onTextChange} onKeyPress={this.onKeyPress} disabled />
            </div>
          </div>
          <div className='simple_form marTopSmall'>
            <label htmlFor='description'>説明文</label>
            <div className='label_input__wrapper'>
              <textarea id='description' rows='1' name='description' placeholder='説明を入力...' className='text optional textareaSmall scrolly' ref={this.setDescriptionDom} onChange={this.onTextChange} />
            </div>
          </div>
          <div className='buttons marTopSmall'>
            <Button className='start buttonSmall' onClick={this.handleSaveClick}  disabled={!this.isTitleModified()}><Icon id='cloud-upload' />&nbsp;タイトルと説明文を保存</Button>
          </div>
          <div className='separator' />
          <div className='thumbnail marTopSmall'>
            <div>サムネイル</div>
            <div className='compose-form nopadding'>
              <div className='compose-form__modifiers'>
                <UploadFormContainer />
              </div>
              <div className='compose-form__buttons-wrapper'>
                <div className='compose-form__buttons'>
                  <UploadButtonContainer />
                  {/* <DeleteButtonContainer /> */}
                </div>
              </div>
            </div>
          </div>
          <div className='marTopSmall'>
            <div>
              {(!this.state.published_at) && <Button className='start' disabled={!canStartPublishStream} onClick={this.onPublishStreamStart}>公開</Button>}
              {(this.state.published_at && !this.state.end_at) && <><Button className='negative marRightSmall' disabled={!!this.state.end_at} onClick={this.onPublishStreamStop}>終了</Button><span>←配信を終了して部屋を閉じるときは必ず「終了」をクリックしてください</span></>}
              {(!this.state.published_at || (this.state.published_at && this.state.end_at)) && <Button className='start' onClick={this.onBackToHome}><Icon id='arrow-left' />&nbsp;ホームに戻る</Button>}
            </div>
          </div>
        </div>
        <ChatArea roomId={roomId} />
      </div>
    );
  }

}
