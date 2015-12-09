module.exports = {
  port: 3030,

  logger: {
    console: true,
    path: 'log/development.log',
  },
  aws: {
    snsNotifyArn: 'arn:aws:sns:us-east-1:024376647576:dev-webflow-notifications',
    snsErrorsArn: 'arn:aws:sns:us-east-1:024376647576:dev-webflow-errors'
  },

  phantom_cluster_num_workers: 2,
  phantom_worker_iterations: 10,
  phantom_cluster_base_port: 12300,
  phantom_cluster_message_timeout: 1000,
  page_done_check_timeout: 300,
  resource_download_timeout: 10000,
  wait_after_last_request: 500,
  js_check_timeout: 500,
  js_timeout: 10 * 1000,
  evaluate_javascript_check_timeout: 300,
  follow_redirect: true,
  kill_between_renders: true,

  awsAccessKey: process.env.AWS_ACCESS_KEY,
  awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,

  s3Bucket: 'webflow-prerender-dev',
  s3_prefix_key: 'prerender'
};
