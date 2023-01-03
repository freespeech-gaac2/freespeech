# frozen_string_literal: true

class Avl::AvlPushStreamInfo
  include ActiveModel::Model

  attr_accessor :push_stream_url
  attr_accessor :m3u8_pull_url
end
