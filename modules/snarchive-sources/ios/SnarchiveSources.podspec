Pod::Spec.new do |s|
  s.name = 'SnarchiveSources'
  s.version = '0.1.0'
  s.summary = 'Read-only source inventory for Snarchive'
  s.description = s.summary
  s.license = { :type => 'MIT', :file => '../../../LICENSE' }
  s.author = 'Alexander Kvalvaag'
  s.homepage = 'https://github.com/alkval/snarchive'
  s.source = { :git => 'https://github.com/alkval/snarchive.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
