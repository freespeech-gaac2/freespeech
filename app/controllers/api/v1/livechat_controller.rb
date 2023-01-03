# frozen_string_literal: true

class Api::V1::LivechatController < Api::BaseController
  include Authorization
  include RoutingHelper
  include FormattingHelper
  include Avl::AvlStreamInfoHelper

  before_action -> { doorkeeper_authorize! :read, :'read:accounts' }
  before_action :require_user!
  before_action :set_firebase

  def create
    room = {
      :user_id => current_account.id.to_s,
      :acct => current_account.acct,
      :display_name => (current_account.display_name.presence || current_account.username),
      :avatar => full_asset_url(current_account.avatar.url),
      :created_at => (Time.now.to_f * 1000).to_i,
      :user_id_room_ended => current_account.id.to_s + '_' + 'false'
    }
    response = @firebase.push('room', room)
    if response.code == 200
      roomId = response.body['name']
      room[:key] = roomId
    end
    render json: room, status: response.code
  end

  # for watcher
  def show
    roomId = params[:id]
    userId = current_account.id.to_s

    response = @firebase.get("room/#{roomId}")
    if response.body.nil?
      render json: { error: 'no room' }, status: 404
      return
    end

    watching = {
      :acct => current_account.acct,
      :display_name => (current_account.display_name.presence || current_account.username),
      :created_at => (Time.now.to_f * 1000).to_i,
      :ping_at => (Time.now.to_f * 1000).to_i,
    }
    response = @firebase.update("watching/#{roomId}/#{userId}", watching)
    render json: watching, status: response.code
  end

  # for publisher
  def update
    puts "Update room => params=: #{params.to_s}"
    roomId = params[:id]
    updateWatching = params[:ping_at]
    room = params.permit(:title, :description, :published_at, :end_at, :thumbnail, :thumbnail_id)

    # use server side timestamp published_at, end_at
    if room.has_key?(:published_at)
      room[:published_at] = (Time.now.to_f * 1000).to_i
    end
    if room.has_key?(:end_at)
      room[:end_at] = (Time.now.to_f * 1000).to_i
      room[:user_id_room_ended] = current_account.id.to_s + '_' + 'true'
    end
    if room.has_key?(:title)
      if room[:title].length > 500
        render json: { error: 'タイトルが長すぎます' }, status: 400 # too long title
        return
      end
      if room[:title].length == 0
        render json: { error: 'タイトルが短すぎます' }, status: 400 # too short title
        return
      end
    end
    if room.has_key?(:description)
      if room[:description].length > 2000
        render json: { error: '説明文が長すぎます' }, status: 400 # too long description
        return
      end
      if room[:description].length == 0
        render json: { error: '説明文が短すぎます' }, status: 400 # too short description
        return
      end
      room[:description_html] = html_aware_format(room[:description], true, preloaded_accounts: [current_account])
    end

    response = @firebase.get("room/#{roomId}")
    if response.body.nil?
      render json: { error: 'no room' }, status: 404
      return
    end
    if response.body['user_id'] != current_account.id.to_s || response.body['acct'] != current_account.acct
      render json: { error: 'you cannot write this room' }, status: 401
      return
    end

    if updateWatching
      room[:ping_at] = (Time.now.to_f * 1000).to_i
      # FIXME move to backend service
      response2 = @firebase.get("watching/#{roomId}")
      if !response2.body.nil?
        watched = response2.body.count
        nowint = (Time.now.to_f * 1000).to_i
        nowint_low = nowint - 60 * 1000 # 60 sec
        nowint_high = nowint + 60 * 1000 # 60 sec
        watching = response2.body.count{|key, value|
          nowint_low < value['ping_at'] and value['ping_at'] < nowint_high
        }
        if response.body['watched'] != watched
          room[:watched] = watched
        end
        if response.body['watching'] != watching
          room[:watching] = watching
        end
      end
    end

    if response.body['status_id'].nil?
      # status_idがなく、published_atを更新する場合は新規tootを発行する
      if room.has_key?(:published_at)
        if response.body['thumbnail_id'].nil?
          media_ids = []
        else
          media_ids = [response.body['thumbnail_id']]
        end
        @status = PostStatusService.new.call(
          current_account,
          text: response.body['title'],
          media_ids: media_ids,
          visibility: 'public',
        )
        room['status_id'] = @status.id.to_s

        url = 'https://' + Rails.configuration.x.web_domain + '/web/@' + @status.account.acct + '/' + @status.id.to_s + '/livechat'
        text = @status.text + "\n\n" + url
        UpdateStatusService.new.call(
          @status,
          current_account.id,
          text: text,
        )
      end
    elsif room.has_key?(:title) or room.has_key?(:thumbnail_id)
      # status_idがあり、title,thumbnailを修正する場合は、同時にtootも更新する
      @status = Status.where(account: current_account).find(response.body['status_id'])
      authorize @status, :update?
      if room.has_key?(:title)
        url = 'https://' + Rails.configuration.x.web_domain + '/web/@' + @status.account.acct + '/' + @status.id.to_s + '/livechat'
        text = room[:title] + "\n\n" + url
        UpdateStatusService.new.call(
          @status,
          current_account.id,
          text: text,
        )
      elsif room.has_key?(:thumbnail_id)
        media_ids = [room[:thumbnail_id]]
        UpdateStatusService.new.call(
          @status,
          current_account.id,
          media_ids: media_ids,
        )
      end
    end

    code = 204
    if !room.empty?
      puts "Update room => room=: #{room.to_s}"
      response = @firebase.update("room/#{roomId}", room)
      code = response.code
    end
    render json: room, status: code
  end

  def available_room
    # check if there is available 'not ended' room for user
    # 'user_id_room_ended' is a 'composite' field used for filtering and must be added as index in firebase
    response = @firebase.get("room",{:orderBy => '"user_id_room_ended"', :equalTo => '"' + current_account.id.to_s + '_' + 'false' + '"' })
    if response.code == 200
      if response.body.values.length > 0
        room = response.body.values[0]
        room[:key] = response.body.keys[0]
        render json: room, status: response.code
      else
        render json: { error: 'no room' }, status: 404
      end
    else
      render json: { error: 'error' }, status: response.code
    end
  end

  private

  def set_firebase
    # private_key_json_string = File.open(ENV['GOOGLE_APPLICATION_CREDENTIALS']).read
    # @firebase = Firebase::Client.new(ENV['FIREBASE_DATABASEURL'], private_key_json_string)
    puts "#{ENV['FIREBASE_DATABASEURL']}, #{ENV['FIREBASE_DATABASE_SECRET']}"
    @firebase = Firebase::Client.new(ENV['FIREBASE_DATABASEURL'], ENV['FIREBASE_DATABASE_SECRET'])
    @firebase.request.connect_timeout = 10
  end

end
