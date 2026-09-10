<?php
/**
 * Front-end output: JSON-LD, shortcodes and the editor block.
 *
 * @package Local_Business_Schema_Hours
 */

defined( 'ABSPATH' ) || exit;

/**
 * Registers everything visitors and search engines see.
 */
class LBSH_Frontend {

	/**
	 * Whether the stylesheet has been queued for this request.
	 *
	 * @var bool
	 */
	private static $styled = false;

	/**
	 * Hook into WordPress.
	 *
	 * @return void
	 */
	public static function init() {
		add_action( 'wp_head', array( __CLASS__, 'render_schema' ), 20 );
		add_shortcode( 'business_hours', array( __CLASS__, 'shortcode_hours' ) );
		add_shortcode( 'business_status', array( __CLASS__, 'shortcode_status' ) );
		add_shortcode( 'business_open', array( __CLASS__, 'shortcode_conditional' ) );
		add_shortcode( 'business_closed', array( __CLASS__, 'shortcode_conditional' ) );
		add_action( 'init', array( __CLASS__, 'register_blocks' ) );
	}

	/**
	 * Output LocalBusiness JSON-LD in the document head.
	 *
	 * Emitted once per request on the front page and on any singular view, which
	 * is where Google looks for business-level markup.
	 *
	 * @return void
	 */
	public static function render_schema() {
		if ( ! apply_filters( 'lbsh_output_schema', is_front_page() || is_singular() ) ) {
			return;
		}

		$nodes = array();

		foreach ( LBSH_Locations::get_all() as $location ) {
			$nodes[] = LBSH_Schema::build( $location, LBSH_Locations::schedule( $location ) );
		}

		if ( empty( $nodes ) ) {
			return;
		}

		$payload = 1 === count( $nodes )
			? $nodes[0]
			: array(
				'@context' => 'https://schema.org',
				'@graph'   => array_map(
					static function ( $node ) {
						unset( $node['@context'] );
						return $node;
					},
					$nodes
				),
			);

		$json = wp_json_encode( $payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		if ( false === $json ) {
			return;
		}

		echo "\n<!-- Local Business Schema & Hours -->\n";
		echo '<script type="application/ld+json">' . $json . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- wp_json_encode output in a JSON-LD context.
	}

	/**
	 * Resolve the location a shortcode refers to.
	 *
	 * @param array $atts Shortcode attributes.
	 * @return array|null
	 */
	private static function resolve( array $atts ) {
		if ( ! empty( $atts['location'] ) ) {
			return LBSH_Locations::get( $atts['location'] );
		}

		return LBSH_Locations::primary();
	}

	/**
	 * Queue the front-end stylesheet on first use.
	 *
	 * @return void
	 */
	private static function enqueue_style() {
		if ( self::$styled ) {
			return;
		}

		self::$styled = true;

		wp_enqueue_style(
			'lbsh-frontend',
			LBSH_URL . 'assets/css/frontend.css',
			array(),
			LBSH_VERSION
		);
	}

	/**
	 * Render the weekly hours table.
	 *
	 * @param array $atts Shortcode attributes.
	 * @return string
	 */
	public static function shortcode_hours( $atts ) {
		$atts = shortcode_atts(
			array(
				'location'  => '',
				'highlight' => 'yes',
				'closed'    => __( 'Closed', 'local-business-schema-hours' ),
			),
			$atts,
			'business_hours'
		);

		$location = self::resolve( $atts );

		if ( null === $location ) {
			return '';
		}

		self::enqueue_style();

		$schedule = LBSH_Locations::schedule( $location );
		$weekly   = $schedule->weekly();
		$today    = strtolower( ( new DateTimeImmutable( 'now', $schedule->timezone() ) )->format( 'D' ) );
		$labels   = self::day_labels();

		$rows = '';

		foreach ( LBSH_Schedule::DAYS as $day ) {
			$classes = 'lbsh-row';

			if ( 'yes' === $atts['highlight'] && $day === $today ) {
				$classes .= ' lbsh-row--today';
			}

			if ( empty( $weekly[ $day ] ) ) {
				$value = esc_html( $atts['closed'] );
			} else {
				$parts = array();

				foreach ( $weekly[ $day ] as $period ) {
					$parts[] = esc_html(
						self::format_time( $period['open'] ) . '&ndash;' . self::format_time( $period['close'] )
					);
				}

				$value = implode( '<br />', $parts );
			}

			$rows .= sprintf(
				'<div class="%1$s"><span class="lbsh-day">%2$s</span><span class="lbsh-time">%3$s</span></div>',
				esc_attr( $classes ),
				esc_html( $labels[ $day ] ),
				$value
			);
		}

		return '<div class="lbsh-hours">' . $rows . '</div>';
	}

	/**
	 * Render an open/closed badge.
	 *
	 * @param array $atts Shortcode attributes.
	 * @return string
	 */
	public static function shortcode_status( $atts ) {
		$atts = shortcode_atts(
			array(
				'location'   => '',
				'open_text'  => __( 'Open now', 'local-business-schema-hours' ),
				'closed_text' => __( 'Closed', 'local-business-schema-hours' ),
				'show_next'  => 'yes',
			),
			$atts,
			'business_status'
		);

		$location = self::resolve( $atts );

		if ( null === $location ) {
			return '';
		}

		self::enqueue_style();

		$schedule = LBSH_Locations::schedule( $location );
		$is_open  = $schedule->is_open();

		$label = $is_open ? $atts['open_text'] : $atts['closed_text'];
		$next  = 'yes' === $atts['show_next'] ? $schedule->next_change() : null;

		$detail = '';

		if ( null !== $next ) {
			$when = self::format_relative( $next['at'], $schedule );

			$detail = sprintf(
				' <span class="lbsh-next">%s</span>',
				esc_html(
					'closes' === $next['state']
						/* translators: %s: time or day the business closes. */
						? sprintf( __( 'closes %s', 'local-business-schema-hours' ), $when )
						/* translators: %s: time or day the business opens. */
						: sprintf( __( 'opens %s', 'local-business-schema-hours' ), $when )
				)
			);
		}

		return sprintf(
			'<span class="lbsh-status %1$s"><span class="lbsh-dot"></span>%2$s%3$s</span>',
			$is_open ? 'lbsh-status--open' : 'lbsh-status--closed',
			esc_html( $label ),
			$detail
		);
	}

	/**
	 * Show or hide wrapped content based on the current state.
	 *
	 * @param array  $atts    Shortcode attributes.
	 * @param string $content Wrapped content.
	 * @param string $tag     Shortcode name.
	 * @return string
	 */
	public static function shortcode_conditional( $atts, $content = '', $tag = '' ) {
		$atts = shortcode_atts( array( 'location' => '' ), $atts, $tag );

		$location = self::resolve( $atts );

		if ( null === $location || null === $content ) {
			return '';
		}

		$is_open = LBSH_Locations::schedule( $location )->is_open();
		$wants   = 'business_open' === $tag;

		return $is_open === $wants ? do_shortcode( $content ) : '';
	}

	/**
	 * Register the server-rendered editor blocks.
	 *
	 * Rendering on the server keeps the markup identical to the shortcodes and
	 * avoids shipping a build step.
	 *
	 * @return void
	 */
	public static function register_blocks() {
		if ( ! function_exists( 'register_block_type' ) ) {
			return;
		}

		register_block_type(
			'lbsh/hours',
			array(
				'api_version'     => 2,
				'title'           => __( 'Business hours', 'local-business-schema-hours' ),
				'category'        => 'widgets',
				'attributes'      => array(
					'location'  => array(
						'type'    => 'string',
						'default' => '',
					),
					'highlight' => array(
						'type'    => 'string',
						'default' => 'yes',
					),
				),
				'render_callback' => array( __CLASS__, 'shortcode_hours' ),
			)
		);

		register_block_type(
			'lbsh/status',
			array(
				'api_version'     => 2,
				'title'           => __( 'Open now badge', 'local-business-schema-hours' ),
				'category'        => 'widgets',
				'attributes'      => array(
					'location'  => array(
						'type'    => 'string',
						'default' => '',
					),
					'show_next' => array(
						'type'    => 'string',
						'default' => 'yes',
					),
				),
				'render_callback' => array( __CLASS__, 'shortcode_status' ),
			)
		);
	}

	/**
	 * Translated weekday labels.
	 *
	 * @return array
	 */
	private static function day_labels() {
		return array(
			'mon' => __( 'Monday', 'local-business-schema-hours' ),
			'tue' => __( 'Tuesday', 'local-business-schema-hours' ),
			'wed' => __( 'Wednesday', 'local-business-schema-hours' ),
			'thu' => __( 'Thursday', 'local-business-schema-hours' ),
			'fri' => __( 'Friday', 'local-business-schema-hours' ),
			'sat' => __( 'Saturday', 'local-business-schema-hours' ),
			'sun' => __( 'Sunday', 'local-business-schema-hours' ),
		);
	}

	/**
	 * Format a stored 'H:i' value using the site's time format.
	 *
	 * @param string $time Time as 'H:i'.
	 * @return string
	 */
	private static function format_time( $time ) {
		$parts = explode( ':', $time );
		$stamp = mktime( (int) $parts[0], (int) $parts[1], 0, 1, 1, 2000 );

		return date_i18n( (string) get_option( 'time_format', 'H:i' ), $stamp );
	}

	/**
	 * Describe an upcoming moment as a time, or a day plus time when further out.
	 *
	 * @param DateTimeImmutable $moment   Upcoming moment.
	 * @param LBSH_Schedule     $schedule Schedule providing the timezone.
	 * @return string
	 */
	private static function format_relative( DateTimeImmutable $moment, LBSH_Schedule $schedule ) {
		$now   = new DateTimeImmutable( 'now', $schedule->timezone() );
		$time  = self::format_time( $moment->format( 'H:i' ) );
		$today = $now->format( 'Y-m-d' );

		if ( $moment->format( 'Y-m-d' ) === $today ) {
			/* translators: %s: clock time. */
			return sprintf( __( 'at %s', 'local-business-schema-hours' ), $time );
		}

		if ( $moment->format( 'Y-m-d' ) === $now->modify( '+1 day' )->format( 'Y-m-d' ) ) {
			/* translators: %s: clock time. */
			return sprintf( __( 'tomorrow at %s', 'local-business-schema-hours' ), $time );
		}

		$labels = self::day_labels();
		$day    = $labels[ strtolower( $moment->format( 'D' ) ) ];

		/* translators: 1: weekday name, 2: clock time. */
		return sprintf( __( '%1$s at %2$s', 'local-business-schema-hours' ), $day, $time );
	}
}
