<?php
/**
 * Read-only REST endpoints for the current open/closed state.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Exposes location status so themes, apps and cached pages can read it live.
 *
 * Full-page caching would otherwise freeze an "open now" badge at whatever
 * state it had when the page was cached; fetching this endpoint from the
 * front end keeps the badge accurate.
 */
class LBSH_Rest {

	const NAMESPACE_ROOT = 'lbsh/v1';

	/**
	 * Hook into WordPress.
	 *
	 * @return void
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Register the status routes.
	 *
	 * @return void
	 */
	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE_ROOT,
			'/status',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_status' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'location' => array(
						'type'              => 'string',
						'required'          => false,
						'sanitize_callback' => 'sanitize_key',
					),
				),
			)
		);
	}

	/**
	 * Return the state of one location, or of all of them.
	 *
	 * @param WP_REST_Request $request Incoming request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_status( WP_REST_Request $request ) {
		$requested = $request->get_param( 'location' );

		if ( ! empty( $requested ) ) {
			$location = LBSH_Locations::get( $requested );

			if ( null === $location ) {
				return new WP_Error(
					'lbsh_location_not_found',
					__( 'No such location.', 'local-business-schema-hours' ),
					array( 'status' => 404 )
				);
			}

			$locations = array( $location );
		} else {
			$locations = LBSH_Locations::get_all();
		}

		$out = array();

		foreach ( $locations as $location ) {
			$schedule = LBSH_Locations::schedule( $location );
			$next     = $schedule->next_change();

			$out[] = array(
				'id'       => (string) $location['id'],
				'name'     => (string) $location['name'],
				'timezone' => $schedule->timezone()->getName(),
				'open'     => $schedule->is_open(),
				'next'     => null === $next
					? null
					: array(
						'state' => $next['state'],
						'at'    => $next['at']->format( DATE_ATOM ),
					),
			);
		}

		$response = rest_ensure_response( $out );
		$response->header( 'Cache-Control', 'public, max-age=60' );

		return $response;
	}
}
