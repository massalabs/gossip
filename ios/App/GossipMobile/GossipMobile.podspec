# The offline mesh node (gossip-mobile, Rust, from the gossip-node repository)
# as its own Swift module, so its UniFFI types do not clash with the app's.
# generated/ is filled by scripts/build-mesh-ios.sh and gitignored; the
# Podfile only adds this pod once it exists.
Pod::Spec.new do |s|
  s.name                = 'GossipMobile'
  s.version             = '0.1.0'
  s.summary             = 'Gossip offline mesh node (UniFFI bindings to gossip-mobile)'
  s.homepage            = 'https://github.com/massalabs/gossip'
  s.license             = { :type => 'AGPL-3.0-or-later' }
  s.author              = 'Massa Labs'
  s.source              = { :path => '.' }
  s.platform            = :ios, '15.0'
  s.swift_version       = '5.9'
  s.source_files        = 'generated/swift/GossipMobile.swift'
  s.vendored_frameworks = 'generated/GossipMobileFFI.xcframework'
  s.static_framework    = true
end
