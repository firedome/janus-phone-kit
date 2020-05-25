import {BasePlugin} from "./BasePlugin";
import {randomString} from "../util/util";
import {logger} from "../util/logger";
import {Member} from "../Member";
import DeviceManager from "../util/DeviceManager";
import { v4 as uuidv4 } from 'uuid';

export class VideoRoomPlugin extends BasePlugin {
  name = 'janus.plugin.videoroomjs'
  memberList: any = {}
  room_id = 1234
  publishers = null
  displayName: string = ''
  rtcConnection: any = new RTCPeerConnection();

  stream: MediaStream;
  offerOptions: any = {}

  constructor(options: any = {}) {
    super()
    this.opaqueId = `videoroomtest-${randomString(12)}`;
    this.displayName = options.displayName
    this.room_id = options.roomId
    logger.debug('Init plugin', this);
    // Send ICE events to Janus.
    this.rtcConnection.onicecandidate = (event) => {

      if (this.rtcConnection.signalingState !== 'stable') {
        return;
      }
      this.sendTrickle(event.candidate || null)
        .catch((err) => {
          logger.warn(err)
        });
    };
  }

  /**
   * Start or stop echoing video.
   * @public
   * @param {Boolean} enabled
   * @return {Object} The response from Janus
   */
  async enableVideo(enabled) {
    return this.sendMessage({video: enabled});
  }

  /**
   * Start or stop echoing audio.
   *
   * @public
   * @param {Boolean} enabled
   * @return {Object} The response from Janus
   */
  async enableAudio(enabled) {
    return this.sendMessage({audio: enabled});
  }

  /**
   * Send a REMB packet to the browser to set the media submission bandwidth.
   *
   * @public
   * @param {Number} bitrate - Bits per second
   * @return {Object} The response from Janus
   */
  async setBitrate(bitrate) {
    return this.sendMessage({bitrate});
  }

  /**
   * Receive an asynchronous ('pushed') message sent by the Janus core.
   *
   * @public
   * @override
   */
  async receive(msg) {

    if (msg?.plugindata?.data?.error_code) {
      return
    }

    if (msg?.plugindata?.data?.videoroom === 'attached') {
      this.onVideoRoomAttached(msg)
      return
    }

    if (msg?.janus === 'hangup') {
      this.onHangup(msg.sender)
      return

    }

    if (msg?.plugindata?.data?.publishers) {
      this.onReceivePublishers(msg)
    }
  }

  private onHangup(sender) {
    const members = Object.values(this.memberList)
    const hangupMember: any = members.find((member: any) => member.handleId === sender);

    if (!hangupMember) {
      return
    }
    hangupMember.hangup();
  }

  private onVideoRoomAttached(message) {
    if (this.memberList[message?.plugindata?.data?.id]) {
      this.memberList[message?.plugindata?.data?.id].answerAttachedStream(message);
    }
  }

  private onReceivePublishers(msg) {
    msg?.plugindata?.data?.publishers.forEach((publisher) => {

      if (!this.memberList[publisher.id] && !this.myFeedList.includes(publisher.id)) {
        this.memberList[publisher.id] = new Member(publisher, this);
        this.memberList[publisher.id].attachMember();
      }
    });

    this.publishers = msg?.plugindata?.data?.publishers;
    this.private_id = msg?.plugindata?.data?.private_id;
  }

  async requestAudioAndVideoPermissions() {
    logger.info('Asking user to share media. Please wait...');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: "user",
          width: { min: 480, ideal: 1280, max: 1920 },
          height: { min: 320, ideal: 720, max: 1080 }
        },
      });
      logger.info('Got local user media.');

    } catch (e) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch (ex) {

        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: false,
        });
      }
    }
    return this.stream
  }

  /**
   * Set up a bi-directional WebRTC connection:
   *
   * 1. get local media
   * 2. create and send a SDP offer
   * 3. receive a SDP answer and add it to the RTCPeerConnection
   * 4. negotiate ICE (can happen concurrently with the SDP exchange)
   * 5. Play the video via the `onaddstream` event of RTCPeerConnection
   *
   * @private
   * @override
   */
  async onAttached() {
    await this.requestAudioAndVideoPermissions();

    const joinResult = await this.sendMessage({
      request: 'join',
      room: this.room_id,
      ptype: 'publisher',
      display: this.displayName,
      opaque_id: this.opaqueId,
    });

    this.session.emit('member:join', {
      stream: this.stream,
      joinResult,
      sender: 'me',
      type: 'publisher',
      name: this.displayName,
      id: uuidv4(),
    })

    logger.info('Adding local user media to RTCPeerConnection.');
    this.addTracks(this.stream)

    await this.sendConfigureMessage({
      audio: true,
      video: true,
    })
  }

  async startVideo() {
    DeviceManager.toggleVideoMute(this.stream)
    await this.enableVideo(true)
  }

  async stopVideo() {
    DeviceManager.toggleVideoMute(this.stream)
    await this.enableVideo(false)
  }

  async startAudio() {
    DeviceManager.toggleAudioMute(this.stream)
    await this.enableAudio(true)
  }

  async stopAudio() {
    DeviceManager.toggleAudioMute(this.stream)
    await this.enableAudio(false)
  }

  async changePublisherStream(stream) {
    this.stream.getTracks().forEach(track => {
      track.stop();
    });
    this.stream = stream
  }

  async sendConfigureMessage(options) {
    const jsepOffer = await this.rtcConnection.createOffer(this.offerOptions);
    await this.rtcConnection.setLocalDescription(jsepOffer);

    const confResult = await this.sendMessage({
      request: 'configure',
      ...options,
    }, jsepOffer);

    await this.rtcConnection.setRemoteDescription(confResult.jsep);

    return confResult
  }

  addTracks(stream: MediaStream) {
    stream.getTracks().forEach((track) => {
      this.rtcConnection.addTrack(track, stream);
    });
  }

  async hangup() {
    if (this.rtcConnection) {
      this.rtcConnection.close();
      this.rtcConnection = null;
    }

    await this.send({ janus: 'hangup' });
  }
}
